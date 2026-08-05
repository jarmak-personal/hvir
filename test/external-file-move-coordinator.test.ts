import { describe, expect, it, vi } from 'vitest'

import {
  ProjectFileOperationCoordinator,
  type ExternalFileGrantRegistry,
  type ProjectFileOperationResourcePort,
} from '../src/main/project-file-operations'

const owner = { id: 11, generation: 4 }

describe('external move coordinator acquisition', () => {
  it('discloses the adapter-owned platform policy without exposing paths', () => {
    const fixture = coordinatorFixture()

    expect(fixture.coordinator.discloseExternalMove(owner)).toEqual({
      outcome: 'available',
      picker: {
        kind: 'files-or-single-directory',
        limitation: 'files or one folder',
      },
      recovery: 'recoverable',
    })
    expect(JSON.stringify(fixture.coordinator.discloseExternalMove(owner))).not.toContain(
      '/outside',
    )
  })

  it('mints a move-only grant from the exact native selection', async () => {
    const fixture = coordinatorFixture()

    const result = await fixture.coordinator.acquireExternalMove(owner, 'files')

    expect(result).toEqual({
      outcome: 'available',
      grant: { grantId: 'move-grant', generation: 9, items: [] },
    })
    expect(JSON.stringify(result)).not.toContain('/outside')
    expect(fixture.picker.pick).toHaveBeenCalledWith('files')
    expect(fixture.externalFiles.acquire).toHaveBeenCalledWith(
      owner,
      ['/outside/selected.txt'],
      'move',
    )
  })

  it('rejects a platform-incompatible selection before opening the native picker', async () => {
    const fixture = coordinatorFixture()

    await expect(fixture.coordinator.acquireExternalMove(owner, 'mixed')).rejects.toThrow(
      'Invalid native selection mode',
    )
    expect(fixture.picker.pick).not.toHaveBeenCalled()
  })

  it('rechecks renderer ownership after native selection before granting authority', async () => {
    const fixture = coordinatorFixture()
    fixture.picker.pick.mockImplementation(() => {
      fixture.resources.current = false
      return Promise.resolve(['/outside/late.txt'])
    })

    await expect(fixture.coordinator.acquireExternalMove(owner, 'files')).rejects.toThrow(
      'renderer owner is no longer current',
    )
    expect(fixture.externalFiles.acquire).not.toHaveBeenCalled()
  })

  it('reports unavailable when recoverable application-host Trash is absent', () => {
    const fixture = coordinatorFixture(false)

    expect(fixture.coordinator.discloseExternalMove(owner)).toEqual({
      outcome: 'unavailable',
      reason: 'Recoverable application-host Trash is unavailable',
    })
  })

  it('releases only the exact owner-scoped move grant', () => {
    const fixture = coordinatorFixture()

    expect(fixture.coordinator.releaseExternalMove(owner, 'move-grant', 9)).toBe(true)
    expect(fixture.externalFiles.release).toHaveBeenCalledWith(
      owner,
      'move-grant',
      9,
      'move',
    )
    expect(() => fixture.coordinator.releaseExternalMove(owner, 'move-grant', 0)).toThrow(
      'Invalid external file grant',
    )
  })
})

function coordinatorFixture(supportsExternalMove = true) {
  const resources = new Resources()
  const externalFiles = {
    supportsExternalMove,
    acquire: vi.fn(() =>
      Promise.resolve({
        outcome: 'available' as const,
        grant: { grantId: 'move-grant', generation: 9, items: [] },
      }),
    ),
    release: vi.fn(() => true),
    dispose: vi.fn(),
  }
  const picker = {
    policy: {
      kind: 'files-or-single-directory' as const,
      limitation: 'files or one folder',
    },
    pick: vi.fn(() => Promise.resolve(['/outside/selected.txt'])),
  }
  const coordinator = new ProjectFileOperationCoordinator({
    resolveWorkspace: () => undefined,
    resources,
    externalFiles: externalFiles as unknown as ExternalFileGrantRegistry,
    externalMovePicker: picker,
  })
  return { coordinator, resources, externalFiles, picker }
}

class Resources implements ProjectFileOperationResourcePort {
  current = true

  isRendererCurrent(): boolean {
    return this.current
  }

  registerOperation(): { release(): void } {
    return { release: () => undefined }
  }
}
