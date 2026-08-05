// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { useProjectWatchInterests } from '../src/renderer/src/workspaces/project-watch-interests'
import { asHostId, hostPath, type HostPath } from '../src/shared'

let host: HTMLDivElement
let root: Root
let invoke: ReturnType<typeof vi.fn>

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  invoke = vi.fn().mockResolvedValue({ ok: true, value: { accepted: 2, limited: false } })
  Object.defineProperty(window, 'hvir', {
    configurable: true,
    value: { invoke },
  })
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('project watch interests', () => {
  it('propagates a declared SSH dependency through the bounded directory-interest seam', async () => {
    const hostId = asHostId('ssh:fixture')
    const project = hostPath(hostId, '/project')
    const documentPath = hostPath(hostId, '/project/docs/readme.md')
    const dependencyPath = hostPath(hostId, '/project/assets/diagram.png')

    render(project, [documentPath], [])
    await settle()
    expect(invoke).toHaveBeenLastCalledWith('project:watch-interests', {
      root: project,
      paths: [hostPath(hostId, '/project/docs')],
    })

    render(project, [documentPath], [dependencyPath])
    await settle()
    expect(invoke).toHaveBeenLastCalledWith('project:watch-interests', {
      root: project,
      paths: [hostPath(hostId, '/project/docs'), hostPath(hostId, '/project/assets')],
    })
  })
})

function render(
  project: HostPath,
  openPaths: readonly HostPath[],
  dependencyPaths: readonly HostPath[],
): void {
  act(() =>
    root.render(
      <Harness
        project={project}
        openPaths={openPaths}
        dependencyPaths={dependencyPaths}
      />,
    ),
  )
}

function Harness({
  project,
  openPaths,
  dependencyPaths,
}: {
  readonly project: HostPath
  readonly openPaths: readonly HostPath[]
  readonly dependencyPaths: readonly HostPath[]
}): null {
  useProjectWatchInterests({
    root: project,
    connected: true,
    openPaths,
    dependencyPaths,
  })
  return null
}

async function settle(): Promise<void> {
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
  })
}
