// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
import { useWorkspaceDirectoryReveal } from '../src/renderer/src/workbench/use-workspace-directory-reveal'
import { useTerminalPathActivation } from '../src/renderer/src/workbench/use-terminal-path-activation'
import { localPath, type HostPath } from '../src/shared/host-path'

async function settle(change: () => void): Promise<void> {
  await act(async () => {
    change()
    await Promise.resolve()
  })
}

it('retains completed Files directory navigation when its Skills surface hides, then yields to ordinary Files selection/workspace changes', async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
  const mount = document.createElement('div'),
    root = createRoot(mount),
    project = localPath('/project'),
    folder = localPath('/project/.skills/example'),
    focus = vi.fn()
  let current!: ReturnType<typeof useWorkspaceDirectoryReveal>
  function Harness({
    workspace = project,
    selected,
    skills = true,
  }: {
    workspace?: HostPath
    selected?: HostPath
    skills?: boolean
  }) {
    current = useWorkspaceDirectoryReveal(workspace, selected, focus)
    return <div hidden={!skills} />
  }
  try {
    await settle(() => root.render(<Harness />))
    await settle(() => current.reveal(folder))
    expect(current.request).toEqual({ path: folder, token: 1, focusRow: true })
    expect(focus).toHaveBeenCalledTimes(1)
    await settle(() => root.render(<Harness skills={false} />))
    expect(current.request?.path).toEqual(folder)
    await settle(() =>
      root.render(<Harness skills={false} selected={localPath('/project/README.md')} />),
    )
    expect(current.request).toBeUndefined()
    await settle(() => root.render(<Harness workspace={localPath('/other')} />))
    await settle(() => current.reveal(folder))
    expect(current.request).toBeUndefined()
    expect(focus).toHaveBeenCalledTimes(1)
  } finally {
    await settle(() => root.unmount())
    mount.remove()
  }
})
it('preserves the terminal file navigation port and position while sharing the directory reveal state', async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
  const mount = document.createElement('div'),
    root = createRoot(mount),
    workspace = localPath('/project'),
    path = localPath('/project/example.ts'),
    openFile = vi.fn(),
    focus = vi.fn()
  Object.assign(window, {
    hvir: {
      invoke: vi.fn(() => Promise.resolve({ ok: true, value: { path, type: 'file' } })),
    },
  })
  let current!: ReturnType<typeof useTerminalPathActivation>
  function Harness() {
    current = useTerminalPathActivation({
      root: workspace,
      openFile,
      revealDirectory: focus,
    })
    return null
  }
  try {
    await settle(() => root.render(<Harness />))
    await settle(() => current.activate({ path, line: 7, column: 2 }))
    expect(openFile).toHaveBeenCalledWith(path, {
      line: 7,
      column: 2,
    })
    expect(focus).not.toHaveBeenCalled()
  } finally {
    await settle(() => root.unmount())
    mount.remove()
  }
})
