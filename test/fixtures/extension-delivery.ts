import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { vi } from 'vitest'
import { LocalHost } from '../../src/main/project-host/local-host'
import { ExtensionSourceApprovalOwner } from '../../src/main/extensions/source-approval'
import {
  ExtensionManagedDeliveryOwner,
  type DeliveryCaller,
} from '../../src/main/extensions/managed-delivery'
import type { DeliveryHost } from '../../src/main/extensions/delivery-tree'
import type { ConnectorCaller } from '../../src/main/extensions/connector-execution'
import type { ExtensionActivation } from '../../src/main/extensions/activation'
import type { DeliveryJournal } from '../../src/main/extensions/delivery-journal'
import { asHostId, hostPath, localPath, type HostPath } from '../../src/shared/host-path'

export function deliveryBarrier() {
  let enter!: () => void, resume!: () => void
  return {
    reached: new Promise<void>((resolve) => {
      enter = resolve
    }),
    blocked: new Promise<void>((resolve) => {
      resume = resolve
    }),
    enter: () => enter(),
    resume: () => resume(),
  }
}
/** Owning policy tests use real local filesystem mechanics, qualified as an SSH port fixture. */
export async function deliveryFixture(installationId = 'delivery-installation') {
  const directory = await fs.realpath(
      await fs.mkdtemp(join(tmpdir(), 'hvir-delivery-test-')),
    ),
    local = new LocalHost(),
    remoteId = asHostId('ssh:delivery-fixture')
  const exports = localPath(join(directory, 'exports')),
    root = hostPath(remoteId, join(directory, 'workspace'))
  await fs.mkdir(exports.path)
  await fs.mkdir(root.path)
  const physical = (path: HostPath) => localPath(path.path)
  const remote: DeliveryHost & Pick<LocalHost, 'readTextFilePrefix'> = {
    readTextFilePrefix: (path, options) =>
      local.readTextFilePrefix(physical(path), options),
    hostId: remoteId,
    connectionState: 'connected',
    stat: vi.fn<DeliveryHost['stat']>((path) => local.stat(physical(path))),
    realpath: vi.fn<DeliveryHost['realpath']>(async (path) =>
      hostPath(remoteId, (await local.realpath(physical(path))).path),
    ),
    readdir: vi.fn<DeliveryHost['readdir']>((path) => local.readdir(physical(path))),
    createDirectoryExclusive: vi.fn<DeliveryHost['createDirectoryExclusive']>(
      (path, options) => local.createDirectoryExclusive(physical(path), options),
    ),
    removeFile: vi.fn<DeliveryHost['removeFile']>((path, options) =>
      local.removeFile(physical(path), options),
    ),
    fileTransfer: {
      readFileChunks: (path, options) =>
        local.fileTransfer.readFileChunks(physical(path), options),
      writeFileChunksExclusive: (path, chunks, options) =>
        local.fileTransfer.writeFileChunksExclusive(physical(path), chunks, options),
      setMetadata: (path, options) =>
        local.fileTransfer.setMetadata(physical(path), options),
      renameNoReplace: vi.fn<
        NonNullable<DeliveryHost['fileTransfer']>['renameNoReplace']
      >((from, to, options) =>
        local.fileTransfer.renameNoReplace(physical(from), physical(to), options),
      ),
      removeDirectory: vi.fn<
        NonNullable<DeliveryHost['fileTransfer']>['removeDirectory']
      >((path, options) => local.fileTransfer.removeDirectory(physical(path), options)),
    },
    managedTransfer: {
      entryIdentity: vi.fn<NonNullable<DeliveryHost['managedTransfer']>['entryIdentity']>(
        (path, signal) => local.managedTransfer.entryIdentity(physical(path), signal),
      ),
      writeFileChunksExclusive: vi.fn<
        NonNullable<DeliveryHost['managedTransfer']>['writeFileChunksExclusive']
      >((path, chunks, options) =>
        local.managedTransfer.writeFileChunksExclusive(physical(path), chunks, options),
      ),
      setMetadata: vi.fn<NonNullable<DeliveryHost['managedTransfer']>['setMetadata']>(
        (path, options) => local.managedTransfer.setMetadata(physical(path), options),
      ),
    },
  }
  const activation = {
    installationId,
    generation: 'generation',
    revision: {
      manifest: {
        access: [
          {
            id: 'delivery-source',
            description: 'Exports',
            context: 'application',
            mode: 'delivery-source',
          },
          {
            id: 'delivery-target',
            description: 'Workspace',
            context: 'workspace',
            mode: 'managed-delivery',
          },
        ],
      },
    },
  } as unknown as ExtensionActivation
  const active = new Map([[activation.installationId, activation]])
  let persisted: DeliveryJournal = { records: [], operations: [] },
    domain: unknown = {},
    grants: unknown = [],
    live = true,
    writable = true,
    failCompletion = false,
    identity = true
  const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T
  const authority = {
    active,
    assertWritable: vi.fn(() => {
      if (!writable) throw new Error('Conflicting writer')
      return Promise.resolve()
    }),
    readManagedDeliveries: vi.fn(() => Promise.resolve(clone(persisted))),
    saveManagedDeliveries: vi.fn((value: unknown, current: () => void) => {
      current()
      if (!writable) throw new Error('Conflicting writer')
      const journal = value as DeliveryJournal
      if (
        failCompletion &&
        JSON.stringify(journal.records) !== JSON.stringify(persisted.records)
      )
        throw new Error('Completion save failed')
      persisted = clone(journal)
      return Promise.resolve()
    }),
    readDeliveryDomain: vi.fn(() => Promise.resolve(domain)),
    saveDeliveryDomain: vi.fn((value: unknown, current: () => void) => {
      current()
      domain = clone(value)
      return Promise.resolve()
    }),
    hasInstallationIdentity: () => identity,
    readSourceGrants: vi.fn(() => Promise.resolve(grants)),
    saveSourceGrants: vi.fn((value: unknown, current: () => void) => {
      current()
      grants = clone(value)
      return Promise.resolve()
    }),
  }
  const catalog = {
    local,
    hostById: (id: string) =>
      id === 'local' ? local : id === remoteId ? remote : undefined,
  }
  const approvals = new ExtensionSourceApprovalOwner(catalog, authority, () => {}, {
    workspaces: () => [{ id: 'workspace', name: 'Workspace', host: remoteId, root }],
  })
  await approvals.start()
  for (const input of [
    {
      installationId: activation.installationId,
      source: 'delivery-source',
      root: exports,
    },
    {
      installationId: activation.installationId,
      source: 'delivery-target',
      workspaceId: 'workspace',
    },
  ])
    await approvals.approve((await approvals.prepare(input, () => {})).token)
  const native = {
      assertCaptureReceipt: vi.fn<(caller: ConnectorCaller, value: unknown) => void>(
        () => {},
      ),
    },
    controller = new AbortController()
  const caller: DeliveryCaller = {
    activation,
    view: 'view',
    action: 'action',
    demand: () => true,
    signal: controller.signal,
    current: () => {
      if (!live) throw new Error('View ended')
    },
    context: () => undefined,
    mutationAllowed: true,
    effects: { replace: true, delete: true },
    authorize: vi.fn(),
    admitted: {
      value: {
        surface: 'viewer',
        visible: true,
        workspace: { id: 'workspace', name: 'Workspace', host: remoteId },
      },
      root,
      current: () => live,
    },
  }
  const make = async () => {
    const owner = new ExtensionManagedDeliveryOwner(catalog, approvals, authority, native)
    await owner.start()
    return owner
  }
  const owner = await make()
  let serial = 0
  async function capture(data = 'approved', mode = 0o664, receiver = owner) {
    const path = localPath(join(exports.path, `export-${++serial}`))
    await fs.mkdir(path.path, { mode: 0o755 })
    await fs.writeFile(join(path.path, 'SKILL.md'), data)
    await fs.chmod(join(path.path, 'SKILL.md'), mode)
    return (await receiver.capture(caller, {
      source: 'delivery-source',
      path,
      nativeReceipt: 'native',
    })) as { receipt: string; root: HostPath }
  }
  const target = hostPath(remoteId, join(root.path, '.agents', 'skills', 'skill'))
  async function preview(
    kind: 'add' | 'update' | 'remove',
    receiver = owner,
    record?: string,
    data = 'approved',
  ) {
    const captured = kind === 'remove' ? undefined : await capture(data, 0o664, receiver)
    let plan
    try {
      plan = (await receiver.preview(caller, {
        destination: 'delivery-target',
        target,
        kind,
        sourceVersion: `version-${data}`,
        ...(captured ? { capture: captured.receipt } : {}),
        ...(record ? { record } : {}),
      })) as { receipt: string; operation: string; parents: HostPath[] }
    } catch (reason) {
      if (captured)
        receiver.manifest(caller, { receipt: captured.receipt, release: true })
      throw reason
    }
    return { ...plan, capture: captured?.receipt }
  }
  return {
    directory,
    exports,
    root,
    target,
    local,
    remote,
    approvals,
    activation,
    active,
    authority,
    native,
    caller,
    controller,
    owner,
    make,
    capture,
    preview,
    persisted: () => clone(persisted),
    setPersisted: (value: DeliveryJournal) => {
      persisted = clone(value)
    },
    failCompletion: (value = true) => {
      failCompletion = value
    },
    writable: (value: boolean) => {
      writable = value
    },
    forget: () => {
      identity = false
      const decision = owner.forget(activation.installationId, persisted)
      persisted = clone(decision.journal)
      decision.commitJournal()
      decision.commitDomain()
    },
    close: () => {
      live = false
    },
    async dispose() {
      await owner.dispose()
      approvals.dispose()
      await local.dispose()
      await fs.rm(directory, { recursive: true, force: true })
    },
  }
}
