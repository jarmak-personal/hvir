// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { useViewerWorkspace } from '../src/renderer/src/viewer/use-viewer-workspace'
import { RETAINED_CLEAN_BYTE_LIMIT } from '../src/renderer/src/viewer/viewer-workload-policy'
import { asHostId, hostPath, localPath, type ReadFileResponse } from '../src/shared'

let host: HTMLDivElement
let reactRoot: Root
let workspace: ReturnType<typeof useViewerWorkspace>
let invoke: ReturnType<typeof vi.fn>

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  localStorage.clear()
  host = document.createElement('div')
  document.body.append(host)
  reactRoot = createRoot(host)
  invoke = vi.fn()
  Object.defineProperty(window, 'hvir', {
    configurable: true,
    value: { invoke },
  })
  act(() => reactRoot.render(<ViewerWorkspaceHarness />))
})

afterEach(() => {
  act(() => reactRoot.unmount())
  host.remove()
  localStorage.clear()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('viewer workspace retention', () => {
  it('retains clean metadata and reloads an evicted body through its HostPath', async () => {
    const project = localPath('/project')
    const other = localPath('/other')
    const path = localPath('/project/large.txt')
    invoke.mockResolvedValueOnce({
      ok: true,
      value: file(path, 'loaded', RETAINED_CLEAN_BYTE_LIMIT + 1),
    })

    act(() => workspace.switchWorkspace(project))
    await act(async () => {
      workspace.openFile(path, true)
      await settle()
    })
    expect(workspace.activeTab?.file?.content).toBe('loaded')

    act(() => workspace.switchWorkspace(other))
    const pending = deferred<{ ok: true; value: ReadFileResponse }>()
    invoke.mockReturnValueOnce(pending.promise)
    act(() => workspace.switchWorkspace(project))

    expect(workspace.activeTab).toMatchObject({
      path,
      file: undefined,
      loading: true,
    })
    expect(invoke).toHaveBeenLastCalledWith('fs:read', { path })

    await act(async () => {
      pending.resolve({ ok: true, value: file(path, 'reloaded', 8) })
      await settle()
    })
    expect(workspace.activeTab?.file?.content).toBe('reloaded')
  })

  it('keeps a dirty minor edit authoritative across project return without rereading', async () => {
    const project = localPath('/project')
    const other = localPath('/other')
    const path = localPath('/project/draft.txt')
    invoke.mockResolvedValueOnce({
      ok: true,
      value: file(path, 'original', 8),
    })

    act(() => workspace.switchWorkspace(project))
    await act(async () => {
      workspace.openFile(path, true)
      await settle()
    })
    act(() => workspace.setContent(workspace.activeTab!.id, 'minor edit'))
    act(() => workspace.switchWorkspace(other))
    act(() => workspace.switchWorkspace(project))

    expect(workspace.activeTab).toMatchObject({
      dirty: true,
      file: { content: 'minor edit' },
    })
    expect(invoke).toHaveBeenCalledTimes(1)
  })

  it('remaps pending position state and ignores an in-flight read from the old path', async () => {
    const project = localPath('/project')
    const source = localPath('/project/directory')
    const destination = localPath('/project/renamed')
    const oldPath = localPath('/project/directory/file.ts')
    const newPath = localPath('/project/renamed/file.ts')
    const pending = deferred<{ ok: true; value: ReadFileResponse }>()
    invoke.mockReturnValueOnce(pending.promise)

    act(() => workspace.switchWorkspace(project))
    act(() => workspace.openFile(oldPath, true))
    const oldId = workspace.activeTab!.id
    act(() => {
      workspace.schedulePosition(oldId, {
        mode: 'source',
        line: 19,
        scrollTop: 240,
      })
      expect(workspace.rebindPath(source, destination)).toBe(true)
    })

    expect(workspace.activeTab).toMatchObject({
      path: newPath,
      dirty: false,
      loading: true,
    })
    await act(async () => {
      pending.resolve({ ok: true, value: file(oldPath, 'stale old bytes', 15) })
      await settle()
    })
    expect(workspace.activeTab).toMatchObject({
      path: newPath,
      file: undefined,
      position: { mode: 'source', line: 19, scrollTop: 240 },
    })
  })

  it('drops only a clean destination identity and invalidates both pending reads', async () => {
    const project = localPath('/project')
    const source = localPath('/project/source.ts')
    const destination = localPath('/project/destination.ts')
    const destinationRead = deferred<{ ok: true; value: ReadFileResponse }>()
    const sourceRead = deferred<{ ok: true; value: ReadFileResponse }>()
    invoke
      .mockReturnValueOnce(destinationRead.promise)
      .mockReturnValueOnce(sourceRead.promise)

    act(() => workspace.switchWorkspace(project))
    act(() => workspace.openFile(destination, true))
    const destinationId = workspace.activeTab!.id
    act(() => workspace.openFile(source, true))
    const sourceId = workspace.activeTab!.id
    act(() => {
      workspace.schedulePosition(destinationId, {
        mode: 'source',
        line: 3,
        scrollTop: 20,
      })
      workspace.schedulePosition(sourceId, {
        mode: 'source',
        line: 41,
        scrollTop: 500,
      })
      expect(workspace.rebindPath(source, destination)).toBe(true)
    })
    await act(nextAnimationFrame)

    expect(workspace.tabs).toHaveLength(1)
    expect(workspace.activeTab).toMatchObject({
      path: destination,
      file: undefined,
      position: { mode: 'source', line: 41, scrollTop: 500 },
    })
    await act(async () => {
      destinationRead.resolve({
        ok: true,
        value: file(destination, 'late destination bytes', 22),
      })
      sourceRead.resolve({ ok: true, value: file(source, 'late source bytes', 17) })
      await settle()
    })
    expect(workspace.activeTab).toMatchObject({ path: destination, file: undefined })
  })

  it('reviews dirty descendants and closes only tabs that are still clean after confirmation', async () => {
    const project = localPath('/project')
    const target = localPath('/project/remove')
    const first = localPath('/project/remove/first.ts')
    const becameDirty = localPath('/project/remove/nested/second.ts')
    const outside = localPath('/project/keep.ts')
    invoke
      .mockResolvedValueOnce({ ok: true, value: file(first, 'first', 5) })
      .mockResolvedValueOnce({ ok: true, value: file(becameDirty, 'second', 6) })
      .mockResolvedValueOnce({ ok: true, value: file(outside, 'outside', 7) })

    act(() => workspace.switchWorkspace(project))
    await act(async () => {
      workspace.openFile(first, true)
      workspace.openFile(becameDirty, true)
      workspace.openFile(outside, true)
      await settle()
    })
    expect(workspace.reviewPathRemoval(target)).toEqual({
      openCount: 2,
      dirtyPaths: [],
    })

    const secondId = workspace.tabs.find((tab) => tab.path.path === becameDirty.path)!.id
    act(() => workspace.setContent(secondId, 'unsaved after confirmation'))
    let cleanup!: ReturnType<typeof workspace.closeCleanPath>
    act(() => {
      cleanup = workspace.closeCleanPath(target)
    })

    expect(cleanup).toEqual({
      openCount: 2,
      dirtyPaths: [becameDirty],
      closedCount: 1,
    })
    expect(workspace.tabs.map((tab) => tab.path)).toEqual([becameDirty, outside])
    expect(workspace.tabs[0]).toMatchObject({
      dirty: true,
      file: { content: 'unsaved after confirmation' },
    })
  })
})

describe('viewer document refresh', () => {
  it.each([
    ['local native watch', localPath('/project'), localPath('/project/image.png')],
    [
      'SSH polling',
      hostPath(asHostId('ssh:fixture'), '/project'),
      hostPath(asHostId('ssh:fixture'), '/project/image.png'),
    ],
  ])('scopes %s events to the exact open document', async (_label, project, path) => {
    invoke.mockResolvedValue({ ok: true, value: file(path, '', 8, true) })
    act(() => workspace.switchWorkspace(project))
    await act(async () => {
      workspace.openFile(path, true)
      await settle()
    })
    invoke.mockClear()

    act(() => {
      workspace.handleWatchEvent({ type: 'change', path: localPath('/unrelated') })
      workspace.handleWatchEvent({
        type: 'change',
        path: hostPath(path.hostId, '/project/other.txt'),
      })
      workspace.handleWatchEvent({ type: 'change', path, synthetic: 'refresh' })
    })

    expect(workspace.activeTab?.refresh).toBeUndefined()
    expect(invoke).not.toHaveBeenCalled()

    await act(async () => {
      workspace.handleWatchEvent({ type: 'change', path })
      await settle()
    })

    expect(workspace.activeTab?.refresh).toEqual({
      version: 1,
      changes: [{ version: 1, path }],
    })
    expect(invoke).toHaveBeenCalledOnce()
    expect(invoke).toHaveBeenCalledWith('fs:read', { path })
  })

  it('retains two matching declared dependency events from one React batch', async () => {
    const project = localPath('/project')
    const documentPath = localPath('/project/readme.md')
    const firstImagePath = localPath('/project/assets/first.png')
    const secondImagePath = localPath('/project/assets/second.png')
    invoke.mockResolvedValue({ ok: true, value: file(documentPath, '# Readme', 8) })
    act(() => workspace.switchWorkspace(project))
    await act(async () => {
      workspace.openFile(documentPath, true)
      await settle()
    })
    act(() =>
      workspace.setRenderedDependencies(workspace.activeTab!.id, [
        firstImagePath,
        secondImagePath,
      ]),
    )
    expect(workspace.renderedWatchPaths).toEqual([firstImagePath, secondImagePath])
    invoke.mockClear()

    act(() => {
      workspace.handleWatchEvent({
        type: 'change',
        path: localPath('/project/assets/other.png'),
      })
      workspace.handleWatchEvent({
        type: 'change',
        path: hostPath(asHostId('ssh:fixture'), firstImagePath.path),
      })
    })
    expect(workspace.activeTab?.refresh).toBeUndefined()

    act(() => {
      workspace.handleWatchEvent({ type: 'change', path: firstImagePath })
      workspace.handleWatchEvent({ type: 'change', path: secondImagePath })
    })

    expect(workspace.activeTab?.refresh).toEqual({
      version: 2,
      changes: [
        { version: 1, path: firstImagePath },
        { version: 2, path: secondImagePath },
      ],
    })
    expect(invoke).not.toHaveBeenCalled()
  })

  it('preserves a dirty buffer and reports the existing matching-file conflict', async () => {
    const project = localPath('/project')
    const path = localPath('/project/draft.md')
    invoke.mockResolvedValue({ ok: true, value: file(path, 'original', 8) })
    act(() => workspace.switchWorkspace(project))
    await act(async () => {
      workspace.openFile(path, true)
      await settle()
    })
    act(() => workspace.setContent(workspace.activeTab!.id, 'minor edit'))
    invoke.mockClear()

    act(() => workspace.handleWatchEvent({ type: 'change', path }))

    expect(workspace.activeTab).toMatchObject({
      dirty: true,
      conflict: true,
      file: { content: 'minor edit' },
    })
    expect(workspace.activeTab?.refresh).toBeUndefined()
    expect(invoke).not.toHaveBeenCalled()
  })
})

function ViewerWorkspaceHarness(): null {
  workspace = useViewerWorkspace({ onActivateFile: () => undefined })
  return null
}

function file(
  path: ReturnType<typeof localPath>,
  content: string,
  size: number,
  binary = false,
): ReadFileResponse {
  return { path, content, size, mtimeMs: 1, binary }
}

function deferred<T>(): {
  readonly promise: Promise<T>
  readonly resolve: (value: T) => void
} {
  let resolve!: (value: T) => void
  return {
    promise: new Promise<T>((accept) => {
      resolve = accept
    }),
    resolve,
  }
}

async function settle(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
}

function nextAnimationFrame(): Promise<void> {
  return new Promise((resolve) => window.requestAnimationFrame(() => resolve()))
}
