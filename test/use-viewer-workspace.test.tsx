// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { useViewerWorkspace } from '../src/renderer/src/viewer/use-viewer-workspace'
import { RETAINED_CLEAN_BYTE_LIMIT } from '../src/renderer/src/viewer/viewer-workload-policy'
import { localPath, type ReadFileResponse } from '../src/shared'

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
})

function ViewerWorkspaceHarness(): null {
  workspace = useViewerWorkspace({ onActivateFile: () => undefined })
  return null
}

function file(
  path: ReturnType<typeof localPath>,
  content: string,
  size: number,
): ReadFileResponse {
  return { path, content, size, mtimeMs: 1, binary: false }
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
