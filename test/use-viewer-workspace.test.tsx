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

    expect(workspace.activeTab?.refresh).toEqual({ version: 1, path })
    expect(invoke).toHaveBeenCalledOnce()
    expect(invoke).toHaveBeenCalledWith('fs:read', { path })
  })

  it('refreshes only a matching declared rendered dependency', async () => {
    const project = localPath('/project')
    const documentPath = localPath('/project/readme.md')
    const imagePath = localPath('/project/assets/diagram.png')
    invoke.mockResolvedValue({ ok: true, value: file(documentPath, '# Readme', 8) })
    act(() => workspace.switchWorkspace(project))
    await act(async () => {
      workspace.openFile(documentPath, true)
      await settle()
    })
    act(() => workspace.setRenderedDependencies(workspace.activeTab!.id, [imagePath]))
    invoke.mockClear()

    act(() => {
      workspace.handleWatchEvent({
        type: 'change',
        path: localPath('/project/assets/other.png'),
      })
      workspace.handleWatchEvent({
        type: 'change',
        path: hostPath(asHostId('ssh:fixture'), imagePath.path),
      })
    })
    expect(workspace.activeTab?.refresh).toBeUndefined()

    act(() => workspace.handleWatchEvent({ type: 'change', path: imagePath }))

    expect(workspace.activeTab?.refresh).toEqual({ version: 1, path: imagePath })
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
