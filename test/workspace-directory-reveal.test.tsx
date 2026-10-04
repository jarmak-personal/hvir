// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import { localPath, type HostPath, type HvirApi } from '../src/shared'
import { useWorkspaceDirectoryReveal } from '../src/renderer/src/workbench/use-workspace-directory-reveal'

afterEach(() => {
  vi.unstubAllGlobals()
  document.body.replaceChildren()
})
it('shares Files selection while refusing stale workspace, outside path and disposed event delivery', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  let receive!: (request: { workspaceId: string; root: HostPath; path: HostPath }) => void
  const stop = vi.fn(),
    focus = vi.fn(),
    api = {
      on: vi.fn((_event: string, listener: typeof receive) => {
        receive = listener
        return stop
      }),
    } as unknown as HvirApi
  Object.defineProperty(window, 'hvir', { configurable: true, value: api })
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  let result!: ReturnType<typeof useWorkspaceDirectoryReveal>
  function Harness({ workspace }: { workspace: string }) {
    result = useWorkspaceDirectoryReveal(localPath('/repo'), undefined, workspace, focus)
    return <span>{result.request?.path.path}</span>
  }
  const event = {
    workspaceId: 'one',
    root: localPath('/repo'),
    path: localPath('/repo/original'),
  }
  try {
    await act(async () => {
      root.render(<Harness workspace="one" />)
      await Promise.resolve()
    })
    await act(async () => {
      receive(event)
      await Promise.resolve()
    })
    expect(result.request?.path).toEqual(event.path)
    expect(focus).toHaveBeenCalledTimes(1)
    await act(async () => {
      root.render(<Harness workspace="two" />)
      await Promise.resolve()
    })
    expect(result.request).toBeUndefined()
    await act(async () => {
      receive(event)
      await Promise.resolve()
    })
    expect(result.request).toBeUndefined()
    await act(async () => {
      root.render(<Harness workspace="one" />)
      await Promise.resolve()
    })
    expect(result.request).toBeUndefined()
    await act(async () => {
      receive({ ...event, path: localPath('/elsewhere') })
      await Promise.resolve()
    })
    expect(result.request).toBeUndefined()
    expect(focus).toHaveBeenCalledTimes(1)
    await act(async () => {
      result.reveal(localPath('/repo/terminal-directory'))
      await Promise.resolve()
    })
    expect(result.request?.path).toEqual(localPath('/repo/terminal-directory'))
    expect(focus).toHaveBeenCalledTimes(2)
    await act(async () => {
      root.unmount()
      await Promise.resolve()
    })
    receive(event)
    expect(stop).toHaveBeenCalledTimes(1)
    expect(focus).toHaveBeenCalledTimes(2)
  } finally {
    await act(async () => {
      root.unmount()
      await Promise.resolve()
    })
  }
})
