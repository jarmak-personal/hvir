import { describe, expect, it, vi } from 'vitest'

import {
  TerminalPathActivationCoordinator,
  type TerminalPathActivationPorts,
} from '../src/renderer/src/workbench/use-terminal-path-activation'
import {
  asHostId,
  hostPath,
  localPath,
  type HostPath,
  type ResolveEntryResponse,
} from '../src/shared'

describe('terminal path activation', () => {
  it.each([
    ['local', localPath('/repo'), localPath('/repo/src/renderer')],
    [
      'SSH',
      hostPath(asHostId('ssh-dev'), '/srv/repo'),
      hostPath(asHostId('ssh-dev'), '/srv/repo/src/renderer'),
    ],
  ])(
    'reveals a host-qualified directory through the active %s workspace',
    async (_label, root, directory) => {
      const ports = fixturePorts('dir')
      const coordinator = coordinatorAt(root, ports)

      await coordinator.activate({ path: directory })

      expect(ports.resolveEntry).toHaveBeenCalledWith(directory)
      expect(ports.revealDirectory).toHaveBeenCalledWith(directory)
      expect(ports.openFile).not.toHaveBeenCalled()
    },
  )

  it('keeps file activation and line-column navigation unchanged', async () => {
    const root = localPath('/repo')
    const file = localPath('/repo/src/main.ts')
    const ports = fixturePorts('file')
    const coordinator = coordinatorAt(root, ports)

    await coordinator.activate({ path: file, line: 19, column: 7 })

    expect(ports.openFile).toHaveBeenCalledWith(file, { line: 19, column: 7 })
    expect(ports.revealDirectory).not.toHaveBeenCalled()
  })

  it('silently ignores lexical, foreign-host, symlink, and unsupported targets', async () => {
    const root = localPath('/repo')
    const ports = fixturePorts('dir')
    const coordinator = coordinatorAt(root, ports)

    await coordinator.activate({ path: localPath('/outside') })
    await coordinator.activate({
      path: hostPath(asHostId('ssh-dev'), '/repo/src'),
    })
    expect(ports.resolveEntry).not.toHaveBeenCalled()

    ports.resolveEntry.mockRejectedValueOnce(
      new Error('Path escapes the project root through a symlink'),
    )
    await coordinator.activate({ path: localPath('/repo/linked-outside') })
    ports.resolveEntry.mockResolvedValueOnce({
      path: localPath('/repo/socket'),
      type: 'other',
    })
    await coordinator.activate({ path: localPath('/repo/socket') })

    expect(ports.openFile).not.toHaveBeenCalled()
    expect(ports.revealDirectory).not.toHaveBeenCalled()
  })

  it('drops a late classification after the active workspace changes', async () => {
    const firstRoot = localPath('/repo')
    const secondRoot = localPath('/repo-other')
    const directory = localPath('/repo/src')
    const pending = deferred<{
      readonly path: HostPath
      readonly type: 'dir'
    }>()
    const ports = fixturePorts('dir')
    ports.resolveEntry.mockReturnValueOnce(pending.promise)
    const coordinator = coordinatorAt(firstRoot, ports)

    const activation = coordinator.activate({ path: directory })
    coordinator.update(secondRoot, ports)
    pending.resolve({ path: directory, type: 'dir' })
    await activation

    expect(ports.revealDirectory).not.toHaveBeenCalled()
    expect(ports.openFile).not.toHaveBeenCalled()
  })

  it('lets a newer activation revoke an older request in the same workspace', async () => {
    const root = localPath('/repo')
    const first = localPath('/repo/first')
    const second = localPath('/repo/second')
    const pending = deferred<ResolveEntryResponse>()
    const ports = fixturePorts('dir')
    ports.resolveEntry.mockReturnValueOnce(pending.promise)
    const coordinator = coordinatorAt(root, ports)

    const firstActivation = coordinator.activate({ path: first })
    await coordinator.activate({ path: second })
    pending.resolve({ path: first, type: 'dir' })
    await firstActivation

    expect(ports.revealDirectory).toHaveBeenCalledOnce()
    expect(ports.revealDirectory).toHaveBeenCalledWith(second)
  })
})

function fixturePorts(type: 'file' | 'dir') {
  const resolveEntry = vi.fn<(path: HostPath) => Promise<ResolveEntryResponse>>((path) =>
    Promise.resolve({ path, type }),
  )
  return {
    resolveEntry,
    openFile: vi.fn(),
    revealDirectory: vi.fn(),
  } satisfies TerminalPathActivationPorts
}

function coordinatorAt(root: HostPath, ports: TerminalPathActivationPorts) {
  const coordinator = new TerminalPathActivationCoordinator(ports)
  coordinator.update(root, ports)
  return coordinator
}

function deferred<T>(): {
  readonly promise: Promise<T>
  readonly resolve: (value: T) => void
} {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((accept) => {
    resolve = accept
  })
  return { promise, resolve }
}
