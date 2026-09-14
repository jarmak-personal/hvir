import { expect, it, onTestFinished, vi } from 'vitest'
import { SkillagerCapability } from '../src/main/skillager/skillager-capability'
import type { SkillagerSyncStatus } from '../src/shared/skillager-library-sync'
import { createRendererResourceFixture } from './fixtures/renderer-resource-fixture'
import {
  syncSelection,
  syncContext,
  syncStatus,
  syncCompletion,
} from './fixtures/skillager-sync-fixture'

it.each(['connect', 'probe', 'disconnect', 'disable'])(
  'aborts active sync observation on %s through the actual capability',
  async (action) => {
    const resources = createRendererResourceFixture(),
      owner = resources.activateOwner()
    let finish!: (value: SkillagerSyncStatus) => void, signal!: AbortSignal
    const unsupported = () => Promise.reject(new Error('Unexpected operation'))
    const cli = {
      probe: () => Promise.resolve(syncSelection),
      validate: () => Promise.resolve(),
      inventory: () => Promise.resolve([]),
      search: () => Promise.resolve([]),
      exposures: () => Promise.resolve([]),
      syncStatus: vi.fn((_selection, _root, received: AbortSignal) => {
        signal = received
        return new Promise<SkillagerSyncStatus>((resolve) => {
          finish = resolve
        })
      }),
      syncApproved: vi.fn(() => Promise.resolve(syncCompletion())),
    }
    const capability = new SkillagerCapability(
      cli,
      resources.scopes,
      () => true,
      {
        cli: {
          review: unsupported,
          accept: unsupported,
          diff: unsupported,
          history: unsupported,
        },
        previews: {
          create: () => {
            throw Error('Unexpected preview')
          },
          release: () => undefined,
        },
      },
      {
        cli: {
          previewExposure: unsupported,
          applyExposure: unsupported,
          updateSourceHash: unsupported,
        },
        observe: () => Promise.resolve([]),
        destinationAvailable: () => true,
      },
      {
        cli: {
          defaultLibraryRoot: unsupported,
          initializeLibrary: unsupported,
          libraryStatus: unsupported,
        },
        picker: { choose: unsupported },
      },
    )
    onTestFinished(() => capability.dispose())
    capability.configure(owner, true)
    const probe = await capability.probe(owner)
    if (!probe.ok) throw Error(probe.message)
    const connected = await capability.connect(owner, probe.value.probeId)
    if (!connected.ok) throw Error(connected.message)
    const pending = capability.librarySync.observe(owner, {
      connectionId: connected.value.connectionId,
      requestId: 1,
      agent: 'codex',
      workspaceRoot: syncContext,
    })
    expect(signal.aborted).toBe(false)
    const replacement =
      action === 'connect'
        ? capability.connect(owner, probe.value.probeId)
        : action === 'probe'
          ? capability.probe(owner)
          : action === 'disable'
            ? capability.configure(owner, false)
            : capability.disconnect(owner)
    expect(signal.aborted).toBe(true)
    finish(syncStatus())
    expect(await pending).toMatchObject({ ok: false })
    if (action === 'connect') {
      const result = await replacement
      expect(result).toMatchObject({ ok: true })
      if (result && result.ok && 'connectionId' in result.value)
        expect(result.value.connectionId).not.toBe(connected.value.connectionId)
    } else await replacement
    expect(cli.syncApproved).not.toHaveBeenCalled()
  },
)
