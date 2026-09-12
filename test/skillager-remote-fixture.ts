import { createHash } from 'node:crypto'
import { vi, onTestFinished } from 'vitest'
import { hostPathEquals, localPath } from '../src/shared/host-path'
import type { HostConnectionState } from '../src/shared'
import type { SkillagerExposureRequest } from '../src/shared/skillager-exposure'
import type { SkillagerMetadata } from '../src/shared/skillager'
import type {
  ManagedDirectoryReceipt,
  ManagedDirectoryTree,
} from '../src/main/project-host/managed-directory'
import {
  ManagedDirectoryError,
  inspectionLocation,
} from '../src/main/project-host/managed-directory-contract'
import {
  SkillagerRemoteExposures,
  type SkillagerRemoteHost,
} from '../src/main/skillager/skillager-remote-exposures'
import { SkillagerDeploymentStore } from '../src/main/skillager/skillager-deployment-store'
import { SkillagerError } from '../src/main/skillager/skillager-port'
import { deploymentFixture } from './skillager-deployment-fixture'

export function remoteFixture() {
  const root = deploymentFixture.destination.root
  let connection: HostConnectionState = 'connected',
    sourceHash = 'a'.repeat(64),
    content = 'test',
    pinned = false,
    unavailable = false
  let storedText: string | undefined,
    counter = 100
  const listeners = new Set<(state: HostConnectionState) => void>()
  const trees = new Map<
    string,
    {
      receipt: ManagedDirectoryReceipt
      bytes: Map<string, Uint8Array>
      modified?: boolean
    }
  >()
  let loseCompletion = false,
    cleanupFails = false
  const location = {
    root,
    rootDevice: '1',
    rootInode: '50',
    ancestors: [
      { entry: '.agents', device: '1', inode: '10' },
      { entry: '.agents/skills', device: '1', inode: '11' },
    ],
    missingParents: [],
  }
  const inspect = vi.fn(
    async (_root: typeof root, entry: string, tree: ManagedDirectoryTree) => {
      await Promise.resolve()
      const current = trees.get(entry)
      if (!current) return { status: 'absent' as const, location }
      if (
        current.modified ||
        JSON.stringify(current.receipt.tree) !== JSON.stringify(tree)
      )
        return { status: 'different' as const }
      return { status: 'exact' as const, receipt: structuredClone(current.receipt) }
    },
  )
  const port = {
    inspect,
    inspectMany: vi.fn(
      async (
        at: typeof root,
        entries: readonly { entry: string; tree: ManagedDirectoryTree }[],
      ) => Promise.all(entries.map((entry) => inspect(at, entry.entry, entry.tree))),
    ),
    stage: vi.fn(
      async (
        _root: typeof root,
        entry: string,
        tree: ManagedDirectoryTree,
        bytes: ReadonlyMap<string, Uint8Array>,
      ) => {
        await Promise.resolve()
        const receipt = {
          ...location,
          entry,
          device: '1',
          inode: String(++counter),
          tree: structuredClone(tree),
        }
        const { missingParents: _missing, ...exact } = receipt
        trees.set(entry, {
          receipt: exact,
          bytes: new Map(
            [...bytes].map(([path, value]) => [path, Uint8Array.from(value)]),
          ),
        })
        return exact
      },
    ),
    commit: vi.fn<NonNullable<SkillagerRemoteHost['managedDirectory']>['commit']>(
      async (operation, options) => {
        await Promise.resolve()
        options.onSubmitted()
        const target =
          operation.action === 'add' ? operation.target : operation.before.entry
        const prior = trees.get(target)
        if (
          (operation.action === 'add' && prior) ||
          (operation.action !== 'add' && (!prior || prior.modified))
        )
          return { status: 'not-applied' }
        let published: ManagedDirectoryReceipt | undefined,
          displaced: ManagedDirectoryReceipt | undefined
        if (operation.action !== 'remove') {
          const candidate = trees.get(operation.candidate.entry)!
          trees.delete(operation.candidate.entry)
          published = { ...candidate.receipt, entry: target }
          trees.set(target, { ...candidate, receipt: published })
        } else trees.delete(target)
        if (operation.action !== 'add' && prior) {
          const entry =
            operation.action === 'remove'
              ? operation.quarantine
              : operation.candidate.entry
          displaced = { ...prior.receipt, entry }
          trees.set(entry, { ...prior, receipt: displaced })
        }
        if (loseCompletion) {
          loseCompletion = false
          throw new ManagedDirectoryError('uncertain', 'Lost completion')
        }
        return { status: 'completed', published, displaced }
      },
    ),
    cleanup: vi.fn(async (receipt: ManagedDirectoryReceipt) => {
      await Promise.resolve()
      if (cleanupFails || trees.get(receipt.entry)?.modified) return false
      return trees.delete(receipt.entry)
    }),
  }
  const host: SkillagerRemoteHost = {
    hostId: root.hostId,
    get connectionState() {
      return connection
    },
    onConnectionState: (listener) => {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    managedDirectory: port,
  }
  const selection = {
    library: deploymentFixture.library,
    executable: localPath('/tools/skillager'),
    catalog: localPath('/catalog'),
    version: 'skillager 0.9.0',
    environment: {},
  }
  const sourceSnapshots: {
    dispose: ReturnType<typeof vi.fn<() => Promise<void>>>
    bytes: Map<string, Uint8Array>
  }[] = []
  const local = {
    validate: vi.fn(async () => {
      await Promise.resolve()
    }),
    exposures: vi.fn(() => Promise.resolve([])),
    previewExposure: vi.fn(() => Promise.reject(Error('Unexpected local preview'))),
    applyExposure: vi.fn(() => Promise.reject(Error('Unexpected local apply'))),
    updateSourceHash: vi.fn(() => Promise.reject(Error('Unexpected local old version'))),
    nativeSnapshot: vi.fn(async () => {
      await Promise.resolve()
      if (unavailable) throw new SkillagerError('review-refused', 'Source unavailable')
      const bytes = new Map([['SKILL.md', Buffer.from(content)]])
      const dispose = vi.fn(async () => {
        await Promise.resolve()
        bytes.clear()
      })
      sourceSnapshots.push({ dispose, bytes })
      return {
        skillId: deploymentFixture.skillId,
        sourceHash,
        pinned,
        targetEntry: deploymentFixture.targetEntry,
        exposureId: deploymentFixture.exposureId,
        tree: {
          files: [
            {
              entry: 'SKILL.md',
              mode: 0o644 as const,
              size: Buffer.byteLength(content),
              sha256: createHash('sha256').update(content).digest('hex'),
            },
          ],
        },
        bytes,
        declarations: ['Assumptions: {"env":["FIXTURE_DECLARATION"]}'],
        dispose,
      }
    }),
    validateNativeSource: vi.fn(
      async (
        _selection: typeof selection,
        snapshot: { sourceHash: string },
        advancing: boolean,
      ) => {
        await Promise.resolve()
        if (unavailable || snapshot.sourceHash !== sourceHash || (advancing && pinned))
          throw new SkillagerError('stale-review', 'Source changed')
      },
    ),
  }
  const fileHost = {
    hostId: localPath('/').hostId,
    readTextFilePrefix: vi.fn(async () => {
      await Promise.resolve()
      if (storedText === undefined)
        throw Object.assign(Error('missing'), { code: 'ENOENT' })
      return {
        content: storedText,
        complete: true,
        byteLength: Buffer.byteLength(storedText),
        lineCount: 1,
      }
    }),
    writeFile: vi.fn(async (_path: unknown, value: Uint8Array | string) => {
      await Promise.resolve()
      storedText = String(value)
    }),
  }
  const store = new SkillagerDeploymentStore(
    fileHost,
    localPath('/state/deployments.json'),
  )
  const adapter = new SkillagerRemoteExposures(local, store, (at) =>
    hostPathEquals(at, root) ? host : undefined,
  )
  onTestFinished(async () => {
    await adapter.dispose()
    await store.dispose()
  })
  const request: SkillagerExposureRequest = {
    connectionId: 'connected',
    requestId: 1,
    workspaceRoot: root,
    agent: 'codex',
    destination: deploymentFixture.destination,
    skillId: deploymentFixture.skillId,
    mode: 'native',
    action: 'add',
  }
  const rows = (): readonly SkillagerMetadata[] => [
    {
      id: request.skillId,
      name: 'Café',
      description: 'fixture',
      trust: unavailable ? 'blocked' : pinned ? 'pinned' : 'reviewed',
      source: {
        ownership: 'library',
        type: 'collection',
        libraryId: selection.library.id,
      },
      contentHash: sourceHash,
      tags: [],
      matchReasons: [],
      exposure: 'unknown',
    },
  ]
  const observe = () =>
    adapter.observe(
      selection,
      request,
      { rows: rows(), complete: true },
      AbortSignal.timeout(1000),
    )
  const existing = async (
    action: 'update' | 'remove',
  ): Promise<SkillagerExposureRequest> => ({
    ...request,
    action,
    exposure: (await observe())![0],
  })
  const add = async () => {
    const snapshot = await adapter.previewExposure(
      selection,
      request,
      AbortSignal.timeout(1000),
    )
    const result = await adapter.applyExposure(
      selection,
      snapshot,
      AbortSignal.timeout(1000),
    )
    await snapshot.dispose!()
    return result
  }
  return {
    adapter,
    store,
    fileHost,
    local,
    port,
    host,
    root,
    trees,
    selection,
    request,
    sourceSnapshots,
    listeners,
    location,
    observe,
    existing,
    add,
    source: (value: string, hash: string, pin = false) => {
      content = value
      sourceHash = hash
      pinned = pin
    },
    unavailable: () => {
      unavailable = true
    },
    disconnect: () => {
      connection = 'disconnected'
      listeners.forEach((listener) => listener(connection))
    },
    reconnect: () => {
      connection = 'connected'
      listeners.forEach((listener) => listener(connection))
    },
    loseCompletion: () => {
      loseCompletion = true
    },
    cleanupFailure: (value = true) => {
      cleanupFails = value
    },
    locationOf: (receipt: ManagedDirectoryReceipt) =>
      inspectionLocation({ status: 'exact', receipt }),
  }
}
