// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  useFileOrganizationActions,
  type FileOrganizationActionsController,
} from '../src/renderer/src/tree/use-file-organization-actions'
import { useViewerWorkspace } from '../src/renderer/src/viewer/use-viewer-workspace'
import {
  localPath,
  type HostPath,
  type ProjectFileOperationProgress,
  type ProjectFileOperationResult,
  type ReadFileResponse,
} from '../src/shared'

let container: HTMLDivElement
let reactRoot: Root
let controller: FileOrganizationActionsController
let operationEvent: ((event: ProjectFileOperationProgress) => void) | undefined
let invoke: ReturnType<typeof vi.fn>
let canRebindPath: ReturnType<
  typeof vi.fn<(source: HostPath, destination: HostPath) => boolean>
>
let rebindPath: ReturnType<
  typeof vi.fn<(source: HostPath, destination: HostPath) => boolean>
>
let onComplete: ReturnType<
  typeof vi.fn<(result: ProjectFileOperationResult | undefined) => void>
>
let onError: ReturnType<typeof vi.fn<(message: string) => void>>
let viewer: ReturnType<typeof useViewerWorkspace>

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  invoke = vi.fn(() =>
    Promise.resolve({
      ok: true,
      value: {
        outcome: 'started',
        operationId: 'organize-1',
        generation: 1,
        itemCount: 1,
      },
    }),
  )
  canRebindPath = vi.fn(() => true)
  rebindPath = vi.fn(() => true)
  onComplete = vi.fn()
  onError = vi.fn()
  Object.defineProperty(window, 'hvir', {
    configurable: true,
    value: {
      invoke,
      on: vi.fn(
        (channel: string, callback: (event: ProjectFileOperationProgress) => void) => {
          if (channel === 'fs:project-file-operation') operationEvent = callback
          return () => undefined
        },
      ),
    },
  })
  container = document.createElement('div')
  document.body.append(container)
  reactRoot = createRoot(container)
  act(() => reactRoot.render(<Harness />))
})

afterEach(() => {
  act(() => reactRoot.unmount())
  container.remove()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('file organization action lifecycle', () => {
  it('accepts one same-tick submission and retains that request for completion', async () => {
    const source = localPath('/repo/source.ts')
    act(() => controller.begin('rename', source, 'file'))

    act(() => {
      controller.submit('first.ts')
      controller.submit('second.ts')
    })
    await act(settle)

    expect(invoke).toHaveBeenCalledTimes(1)
    expect(invoke).toHaveBeenCalledWith('fs:organize-entry', {
      action: 'rename',
      workspaceRoot: localPath('/repo'),
      source,
      name: 'first.ts',
    })

    act(() => operationEvent?.(completed('renamed-entry', '/repo/first.ts')))
    expect(rebindPath).toHaveBeenCalledWith(source, localPath('/repo/first.ts'))
    expect(onComplete).toHaveBeenCalledTimes(1)
  })

  it('reports truthful recovery when a destination becomes dirty after submission', async () => {
    const source = localPath('/repo/source.ts')
    act(() => controller.begin('rename', source, 'file'))
    act(() => controller.submit('destination.ts'))
    await act(settle)
    expect(canRebindPath).toHaveBeenCalledWith(source, localPath('/repo/destination.ts'))

    rebindPath.mockReturnValue(false)
    act(() => operationEvent?.(completed('renamed-entry', '/repo/destination.ts')))

    expect(rebindPath).toHaveBeenCalledWith(source, localPath('/repo/destination.ts'))
    expect(onComplete).toHaveBeenCalledTimes(1)
    expect(onError).toHaveBeenCalledWith(
      expect.stringMatching(
        /filesystem move succeeded.*Both source and destination buffers were preserved/i,
      ),
    )
  })

  it('does not mutate viewer identity after a failed operation', async () => {
    const source = localPath('/repo/source.ts')
    act(() => controller.begin('rename', source, 'file'))
    act(() => controller.submit('failed.ts'))
    await act(settle)

    act(() =>
      operationEvent?.({
        ...completed('renamed-entry', '/repo/failed.ts'),
        result: {
          outcome: 'completed',
          operationId: 'organize-1',
          generation: 1,
          items: [
            {
              itemId: 'organize:0',
              source,
              destination: localPath('/repo/failed.ts'),
              status: 'conflicted',
              effect: 'none',
              reason: 'Destination exists',
            },
          ],
        },
      }),
    )

    expect(rebindPath).not.toHaveBeenCalled()
    expect(onComplete).toHaveBeenCalledTimes(1)
  })

  it('rebinds an ordinary dirty source tab after a deferred successful operation', async () => {
    act(() => reactRoot.unmount())
    invoke.mockImplementation(
      (channel: string, request: { readonly path?: HostPath }): unknown => {
        if (channel === 'fs:read') {
          return Promise.resolve({
            ok: true,
            value: file(request.path!, 'source bytes'),
          })
        }
        return Promise.resolve({
          ok: true,
          value: {
            outcome: 'started',
            operationId: 'organize-1',
            generation: 1,
            itemCount: 1,
          },
        })
      },
    )
    reactRoot = createRoot(container)
    act(() => reactRoot.render(<IntegratedHarness />))
    const source = localPath('/repo/source.ts')

    act(() => viewer.switchWorkspace(localPath('/repo')))
    await act(async () => {
      viewer.openFile(source, true)
      await settle()
    })
    act(() => viewer.setContent(viewer.activeTab!.id, 'unsaved source draft'))
    act(() => controller.begin('rename', source, 'file'))
    act(() => controller.submit('renamed.ts'))
    await act(settle)
    expect(viewer.activeTab).toMatchObject({
      path: source,
      dirty: true,
      file: { content: 'unsaved source draft' },
    })

    act(() => operationEvent?.(completed('renamed-entry', '/repo/renamed.ts')))
    expect(viewer.activeTab).toMatchObject({
      path: localPath('/repo/renamed.ts'),
      dirty: true,
      file: {
        path: localPath('/repo/renamed.ts'),
        content: 'unsaved source draft',
      },
    })
  })
})

function Harness(): null {
  controller = useFileOrganizationActions({
    root: localPath('/repo'),
    canRebindPath,
    onRebindPath: rebindPath,
    onStart: vi.fn(),
    onComplete,
    onError,
  })
  return null
}

function IntegratedHarness(): null {
  viewer = useViewerWorkspace({ onActivateFile: () => undefined })
  controller = useFileOrganizationActions({
    root: localPath('/repo'),
    canRebindPath: viewer.canRebindPath,
    onRebindPath: viewer.rebindPath,
    onStart: vi.fn(),
    onComplete,
    onError,
  })
  return null
}

function completed(
  effect: 'renamed-entry' | 'moved-entry',
  destination: string,
): ProjectFileOperationProgress {
  const result: ProjectFileOperationResult = {
    outcome: 'completed',
    operationId: 'organize-1',
    generation: 1,
    items: [
      {
        itemId: 'organize:0',
        source: localPath('/repo/source.ts'),
        destination: localPath(destination),
        status: 'completed',
        effect,
      },
    ],
  }
  return {
    workspaceRoot: localPath('/repo'),
    operationId: 'organize-1',
    generation: 1,
    phase: 'completed',
    completedItems: 1,
    totalItems: 1,
    result,
  }
}

async function settle(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
}

function file(path: HostPath, content: string): ReadFileResponse {
  return {
    path,
    content,
    size: content.length,
    mtimeMs: 1,
    binary: false,
  }
}
