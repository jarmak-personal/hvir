import { deliveryParents } from './delivery-destination'
import { DeliveryRecovery } from './delivery-recovery'
import {
  deliveryPage,
  deliveryValue,
  deliveryReason,
  proveDeliveryRecoveryEnvelope,
} from './delivery-message'
import { createHash, randomUUID } from 'node:crypto'
import {
  containsHostPath,
  dirnameHostPath,
  hostPathEquals,
  joinHostPath,
  type HostPath,
} from '../../shared/host-path'
import {
  DELIVERY_LIMITS,
  type ExtensionDeliveryRecord,
  type ExtensionDeliveryResult,
  type DeliveryRecoveryReply,
  type DeliveryRecoveryEntry,
} from '../../shared/extensions/managed-delivery'
import { extensionObject, extensionText } from '../../shared/extensions/validation'
import { proveRealProjectDirectory } from '../project-file-operations/project-file-confinement'
import type { ExtensionActivationOwner } from './activation'
import type {
  ConnectorCaller,
  ExtensionConnectorExecutionOwner,
} from './connector-execution'
import type { AdmittedExtensionContext } from './context-owner'
import { readSourcePath, type ExtensionSourceApprovalOwner } from './source-approval'
import {
  readDeliveryJournal,
  deliveryRecoveryEntry,
  deliveryRecordFor,
  retainedDeliveryBytes,
  proveDeliveryJournalCapacity,
  completedDeliveryJournal,
  resolvedDeliveryJournal,
  type DeliveryJournal,
  type DeliveryOperation,
} from './delivery-journal'
import {
  readDeliveryTree,
  stageDeliveryTree,
  deliveryFingerprint,
  type DeliveryHost,
  type DeliveryTree,
} from './delivery-tree'
import type { ExtensionSourceGrant } from '../../shared/extensions/source-access'
import { isProjectPathExistsError } from '../project-host/project-host'

export interface DeliveryCaller extends ConnectorCaller {
  readonly mutationAllowed: boolean
  readonly effects: { readonly delete: boolean; readonly replace: boolean }
  readonly admitted: AdmittedExtensionContext | undefined
  readonly authorize: (host: string, workspace?: string) => void
}
export interface DeliveryHostCatalog {
  hostById(id: string): DeliveryHost | undefined
}
interface Capture {
  released?: boolean
  readonly caller: DeliveryCaller
  readonly grant: ExtensionSourceGrant
  readonly tree: DeliveryTree
  readonly root: HostPath
  readonly expires: number
}
interface Preview {
  readonly id: string
  readonly parents: readonly HostPath[]
  readonly caller: DeliveryCaller
  readonly grant: ExtensionSourceGrant
  readonly capture?: Capture
  readonly target: HostPath
  readonly kind: 'add' | 'update' | 'remove'
  readonly sourceVersion: string
  readonly previous?: DeliveryJournal['records'][number]
  readonly expires: number
}

class DeliveryTargetConflict extends Error {}

/** Mechanical custody only. Extensions own export approval, source versions and domain records. */
export class ExtensionManagedDeliveryOwner {
  private state: DeliveryJournal = { records: [], operations: [] }
  private domains: Record<string, unknown> = {}
  private readonly captures = new Map<string, Capture>()
  private readonly previews = new Map<string, Preview>()
  private readonly physical = new Set<string>()
  private readonly physicalCaptures = new Set<Capture>()
  private readonly captureWork = new Set<Promise<unknown>>()
  readonly recovery: DeliveryRecovery
  private readonly authority = new AbortController()
  private readonly physicalWork = new Set<Promise<unknown>>()
  private pending: Promise<unknown> = Promise.resolve()
  private failure?: string
  private disposed = false
  private journalRevision = randomUUID()
  private capturing = 0
  constructor(
    readonly hosts: DeliveryHostCatalog,
    readonly approvals: ExtensionSourceApprovalOwner,
    private readonly activations: Pick<
      ExtensionActivationOwner,
      | 'active'
      | 'assertWritable'
      | 'readManagedDeliveries'
      | 'saveManagedDeliveries'
      | 'readDeliveryDomain'
      | 'saveDeliveryDomain'
      | 'hasInstallationIdentity'
    >,
    private readonly connectors: Pick<
      ExtensionConnectorExecutionOwner,
      'assertCaptureReceipt'
    >,
  ) {
    this.recovery = new DeliveryRecovery({
      journal: () => this.state,
      host: (path) => this.hosts.hostById(path.hostId),
      writable: () => this.activations.assertWritable(),
      resolve: (operation, forget, current) =>
        this.serialize(() =>
          this.publishJournal(
            resolvedDeliveryJournal(this.state, operation, forget),
            current,
          ),
        ),
      complete: (operation, current) => this.completeRecovered(operation, current),
    })
  }

  async start(): Promise<void> {
    try {
      this.state = readDeliveryJournal(await this.activations.readManagedDeliveries())
      this.domains = extensionObject(await this.activations.readDeliveryDomain())
      for (const value of Object.values(this.domains)) this.checkDomain(value)
    } catch {
      this.failure =
        'Delivery records cannot be read safely. Repair extension-state/deliveries.json; local reading remains available.'
    }
  }
  capture(caller: DeliveryCaller, value: unknown): Promise<unknown> {
    const work = this.captureTree(caller, value)
    this.captureWork.add(work)
    return work.finally(() => this.captureWork.delete(work))
  }
  private async captureTree(caller: DeliveryCaller, value: unknown): Promise<unknown> {
    this.prune()
    this.current(caller)
    const input = extensionObject(value),
      grant = this.grant(caller, input['source'], 'delivery-source')
    const path = readSourcePath(input['path']),
      root = grant.root!
    caller.authorize(root.hostId)
    this.connectors.assertCaptureReceipt(caller, input['nativeReceipt'])
    if (this.captures.size + this.capturing >= DELIVERY_LIMITS.captures)
      throw new Error('Delivery capture capacity is full; release a captured payload')
    const lifetime = AbortSignal.any([
        caller.signal,
        this.authority.signal,
        AbortSignal.timeout(DELIVERY_LIMITS.deadlineMs),
      ]),
      host = this.host(root),
      current = () => {
        lifetime.throwIfAborted()
        this.current(caller)
        this.sameGrant(caller, grant)
        caller.authorize(root.hostId)
      }
    this.capturing++
    try {
      await this.confined(host, root, path, current)
      const tree = await readDeliveryTree(host, path, current, lifetime, true, root)
      if (
        (await readDeliveryTree(host, path, current, lifetime, false, root))
          .fingerprint !== tree.fingerprint
      )
        throw new Error('Export changed during complete capture')
      await this.confined(host, root, path, current)
      current()
      const receipt = randomUUID(),
        capture: Capture = {
          caller,
          grant,
          root: path,
          tree,
          expires: Date.now() + DELIVERY_LIMITS.captureMs,
        }
      const result = deliveryValue({
        receipt,
        root: path,
        fingerprint: tree.fingerprint,
        entries: tree.entries.length,
        files: tree.entries.filter((entry) => entry.type === 'file').length,
        bytes: tree.bytes,
      })
      this.captures.set(receipt, capture)
      return result
    } finally {
      this.capturing--
    }
  }
  manifest(caller: DeliveryCaller, value: unknown): unknown {
    const input = extensionObject(value),
      capture = this.captureFor(caller, input['receipt'])
    if (input['release'] === true) {
      this.releaseCapture(input['receipt'] as string, capture)
      return null
    }
    return deliveryPage(capture.tree.entries, input['offset'])
  }
  async preview(caller: DeliveryCaller, value: unknown): Promise<unknown> {
    this.prune()
    this.current(caller)
    const input = extensionObject(value),
      grant = this.grant(caller, input['destination'], 'managed-delivery')
    const target = readSourcePath(input['target']),
      root = grant.root!
    const kind = input['kind']
    if (!['add', 'update', 'remove'].includes(kind as string))
      throw new Error('Invalid managed delivery operation')
    this.destination(caller, grant)
    caller.authorize(root.hostId, grant.workspaceId)
    const capture =
      kind === 'remove' ? undefined : this.captureFor(caller, input['capture'])
    const previous =
      kind === 'add'
        ? undefined
        : this.state.records.find(
            (entry) =>
              entry.record.id === input['record'] &&
              entry.record.installation === caller.activation.installationId &&
              entry.record.workspace === grant.workspaceId &&
              hostPathEquals(entry.record.root, root) &&
              hostPathEquals(entry.record.target, target),
          )
    if (kind !== 'add' && !previous)
      throw new Error('This exact target has no current managed delivery authority')
    const host = this.host(root),
      current = () => {
        this.current(caller)
        this.sameGrant(caller, grant)
        this.destination(caller, grant)
      }
    const parents = await deliveryParents(host, root, target, current)
    if (
      this.state.operations.some(
        (entry) => entry.phase !== 'completed' && hostPathEquals(entry.target, target),
      )
    )
      throw new Error(
        'Reconcile the exact unfinished delivery before another dependent write',
      )
    if (previous && parents.length)
      throw new Error('Managed target parents are missing; retain its record')
    if (previous)
      await this.verifyManaged(
        host,
        previous.record,
        previous.tree,
        current,
        caller.signal,
      )
    else if (await this.exists(host, target))
      throw new Error('Add cannot overwrite an occupied target')
    const sourceVersion =
      kind === 'remove'
        ? previous!.record.sourceVersion
        : extensionText(input['sourceVersion'], 'exact source version', 256)
    current()
    if (this.previews.size >= 16) throw new Error('Delivery preview capacity is full')
    const receipt = randomUUID(),
      id = randomUUID()
    proveDeliveryRecoveryEnvelope(id, caller.activation.installationId, [
      target,
      joinHostPath(root, '.hvir-delivery-retained', `${id}-stage`),
      joinHostPath(root, '.hvir-delivery-retained', `${id}-preserved`),
      ...parents,
    ])
    deliveryValue({
      parents: parents.map((path) => ({
        path,
        state: 'unverifiable',
        identity: 'x'.repeat(256),
      })),
      staging: joinHostPath(root, '.hvir-delivery-retained', `${id}-stage`),
      preserved: joinHostPath(root, '.hvir-delivery-retained', `${id}-preserved`),
      record: previous?.record,
      target,
      source: capture?.root,
      sourceVersion,
      reason: 'x'.repeat(240),
    })
    const result = deliveryValue({
      receipt,
      operation: id,
      kind,
      sourceVersion,
      source: capture?.root,
      target,
      previous: previous?.record,
      files: capture?.tree.entries.filter((entry) => entry.type === 'file').length ?? 0,
      bytes: capture?.tree.bytes ?? 0,
      preservation: joinHostPath(root, '.hvir-delivery-retained'),
      parents,
      recordEffect:
        kind === 'remove' ? 'remove-completed-authority' : 'record-exact-delivery',
      supportingFiles: true,
    })
    this.previews.set(receipt, {
      id,
      parents,
      caller,
      grant,
      target,
      kind: kind as Preview['kind'],
      sourceVersion,
      ...(capture ? { capture } : {}),
      ...(previous ? { previous } : {}),
      expires: Date.now() + 60_000,
    })
    return result
  }
  apply(caller: DeliveryCaller, value: unknown): Promise<ExtensionDeliveryResult> {
    return this.trackPhysical(this.mutate(caller, value))
  }
  private async mutate(
    caller: DeliveryCaller,
    value: unknown,
  ): Promise<ExtensionDeliveryResult> {
    this.prune()
    this.current(caller)
    if (!caller.mutationAllowed)
      throw new Error(
        'Delivery mutation requires an admitted action or ordinary human view',
      )
    const input = extensionObject(value),
      token = extensionText(input['receipt'], 'delivery preview', 80),
      preview = this.previews.get(token)
    this.previews.delete(token)
    if (!preview || !this.sameCaller(preview.caller, caller))
      throw new Error('Inspect the exact delivery again before applying')
    const { grant, target, kind, previous, capture } = preview
    if (
      (kind === 'update' && !caller.effects.replace) ||
      (kind === 'remove' && !caller.effects.delete)
    )
      throw new Error('The admitted action does not declare these exact delivery effects')
    const root = grant.root!,
      host = this.host(root)
    const current = () => {
      this.current(caller)
      this.sameGrant(caller, grant)
      this.destination(caller, grant)
      caller.authorize(root.hostId, grant.workspaceId)
      this.sameHost(host, root)
      if (capture) {
        if (capture.released || capture.expires <= Date.now())
          throw new Error('Captured payload was released or expired')
        this.sameGrant(caller, capture.grant)
      }
    }
    const key = JSON.stringify(target)
    if (this.physical.size >= DELIVERY_LIMITS.concurrent || this.physical.has(key))
      return {
        outcome: 'refused',
        reason: 'Delivery is busy; wait for physical host work to settle',
      }
    if (
      this.state.operations.length >= DELIVERY_LIMITS.operations ||
      (!previous && this.state.records.length >= DELIVERY_LIMITS.records)
    )
      return {
        outcome: 'refused',
        reason: 'Resolve recorded retained deliveries before staging another payload',
      }
    const retained = this.state.operations.reduce(
      (total, entry) => total + retainedDeliveryBytes(entry),
      0,
    )
    if (
      retained + (capture?.tree.bytes ?? 0) + (previous?.record.bytes ?? 0) >
      DELIVERY_LIMITS.retainedBytes
    )
      return {
        outcome: 'refused',
        reason:
          'Retained delivery capacity is full; resolve exact retained objects first',
      }
    this.physical.add(key)
    if (capture) this.physicalCaptures.add(capture)
    let operation: DeliveryOperation | undefined,
      effects = false
    const timeout = AbortSignal.timeout(DELIVERY_LIMITS.deadlineMs),
      signal = AbortSignal.any([caller.signal, timeout, this.authority.signal])
    const check = () => {
      current()
      signal.throwIfAborted()
    }
    try {
      await this.activations.assertWritable()
      check()
      if (
        JSON.stringify(await deliveryParents(host, root, target, check)) !==
        JSON.stringify(preview.parents)
      )
        throw new Error('Supporting parent effects changed; inspect again')
      const id = preview.id,
        retention = joinHostPath(root, '.hvir-delivery-retained')
      operation = {
        id,
        installation: caller.activation.installationId,
        caller: `${caller.view}/${caller.action ?? 'human'}`,
        workspace: grant.workspaceId!,
        root,
        target,
        stage: joinHostPath(retention, `${id}-stage`),
        preserve: joinHostPath(retention, `${id}-preserved`),
        sourceVersion: preview.sourceVersion,
        kind,
        created: Date.now(),
        payload: capture?.tree.entries ?? [],
        parents: preview.parents.map((path) => ({ path })),
        phase: 'intent',
        ...(previous ? { previous: previous.record, previousTree: previous.tree } : {}),
      }
      if (previous)
        await this.verifyManaged(host, previous.record, previous.tree, check, signal)
      else if (await this.exists(host, target))
        throw new DeliveryTargetConflict('The target is occupied; no files changed')
      if (capture && capture.expires <= Date.now())
        throw new Error('Captured export expired')
      await this.saveOperation(operation, check) // No remote mutation precedes this durable intent.
      check()
      await this.confined(host, root, retention, check, false)
      effects = true
      if (!(await this.exists(host, retention)))
        await host.createDirectoryExclusive(retention, { mode: 0o755, signal })
      await this.confined(host, root, retention, check)
      for (const parent of operation.parents) {
        check()
        await this.confined(host, root, parent.path, check, false)
        await host.createDirectoryExclusive(parent.path, { mode: 0o755, signal })
        parent.identity = await host.managedTransfer!.entryIdentity(parent.path, signal)
        await this.saveOperation(operation, check)
      }
      if (capture) {
        await stageDeliveryTree(host, operation.stage, capture.tree, check, signal, root)
        operation.stageIdentity = await host.managedTransfer!.entryIdentity(
          operation.stage,
          signal,
        )
        operation.phase = 'staged'
        await this.saveOperation(operation, check)
      }
      if (previous) {
        await this.verifyManaged(host, previous.record, previous.tree, check, signal)
        operation.phase = 'displacing'
        await this.saveOperation(operation, check)
        check()
        await this.proveParents(host, operation, check, signal)
        await this.confined(host, root, target, check, false)
        await host.fileTransfer!.renameNoReplace(target, operation.preserve, { signal })
        await this.verifyManaged(
          host,
          { ...previous.record, target: operation.preserve },
          previous.tree,
          check,
          signal,
        )
        operation.preserveIdentity = previous.record.identity
        operation.phase = 'displaced'
        await this.saveOperation(operation, check)
      }
      if (capture) {
        if (await this.exists(host, target))
          throw new DeliveryTargetConflict(
            'Publication target became occupied; both versions remain preserved',
          )
        await this.verifyManaged(
          host,
          this.recordFor(operation),
          capture.tree.entries,
          check,
          signal,
          operation.stage,
        )
        operation.phase = 'publishing'
        await this.saveOperation(operation, check)
        check()
        await this.proveParents(host, operation, check, signal)
        await this.confined(host, root, target, check, false)
        await host.fileTransfer!.renameNoReplace(operation.stage, target, { signal })
        await this.verifyManaged(
          host,
          this.recordFor(operation),
          capture.tree.entries,
          check,
          signal,
        )
      } else if (await this.exists(host, target))
        throw new DeliveryTargetConflict(
          'Remove target was newly occupied; preserved content remains intact',
        )
      const record = capture ? this.recordFor(operation) : undefined
      await this.completeRecovered(operation, check)
      if (capture)
        for (const [id, value] of this.captures)
          if (value === capture) this.captures.delete(id)
      return {
        outcome: 'completed',
        operation: operation.id,
        ...(record ? { record } : {}),
        ...(previous ? { preserved: operation.preserve } : {}),
      }
    } catch (reason) {
      let conflicted = false
      if (
        operation &&
        (reason instanceof DeliveryTargetConflict || isProjectPathExistsError(reason))
      ) {
        try {
          await this.saveOperation({ ...operation, phase: 'conflicted' }, check)
          conflicted = true
        } catch {
          /* Failed conflict saving retains earlier evidence and uncertainty. */
        }
      }
      return {
        outcome: conflicted ? 'conflicted' : effects ? 'uncertain' : 'refused',
        ...(operation
          ? {
              operation: operation.id,
              staging: operation.stage,
              preserved: operation.preserve,
            }
          : {}),
        reason: deliveryReason(reason),
      }
    } finally {
      this.physical.delete(key)
      if (capture) {
        this.physicalCaptures.delete(capture)
        if (capture.released)
          for (const [id, value] of this.captures)
            if (value === capture) this.captures.delete(id)
      }
    }
  }

  status(caller: DeliveryCaller, value: unknown): unknown {
    this.current(caller)
    const input = extensionObject(value)
    const entries =
      input['kind'] === 'operations'
        ? this.recoveryStatus().filter(
            (entry) => entry.installation === caller.activation.installationId,
          )
        : this.state.records
            .filter(
              (entry) => entry.record.installation === caller.activation.installationId,
            )
            .map((entry) => entry.record)
    return {
      ...deliveryPage<unknown>(entries, input['offset']),
      revision: this.journalRevision,
    }
  }
  recoveryStatus(): DeliveryRecoveryEntry[] {
    if (this.failure) throw new Error(this.failure)
    return this.state.operations.map(deliveryRecoveryEntry)
  }

  private recordFor(operation: DeliveryOperation): ExtensionDeliveryRecord {
    return deliveryRecordFor(operation)
  }
  private async proveParents(
    host: DeliveryHost,
    operation: DeliveryOperation,
    current: () => void,
    signal: AbortSignal,
  ): Promise<void> {
    for (const parent of operation.parents) {
      current()
      await this.confined(host, operation.root, parent.path, current)
      if (
        !parent.identity ||
        (await host.managedTransfer!.entryIdentity(parent.path, signal)) !==
          parent.identity
      )
        throw new Error(
          'A created supporting parent changed; retain exact recorded objects',
        )
    }
  }
  private async verifyManaged(
    host: DeliveryHost,
    record: ExtensionDeliveryRecord,
    entries: readonly import('../../shared/extensions/managed-delivery').DeliveryTreeEntry[],
    current: () => void,
    signal: AbortSignal,
    path = record.target,
  ): Promise<void> {
    if (!host.managedTransfer || !record.identity)
      throw new Error('Managed directory identity is unavailable')
    current()
    try {
      if ((await host.stat(path)).type !== 'dir')
        throw new DeliveryTargetConflict('Managed directory was replaced; keep its files')
      const before = await host.managedTransfer.entryIdentity(path, signal)
      if (
        before !== record.identity ||
        (await readDeliveryTree(host, path, current, signal, false, record.root))
          .fingerprint !== deliveryFingerprint(entries) ||
        (await host.managedTransfer.entryIdentity(path, signal)) !== before
      )
        throw new DeliveryTargetConflict('Managed target changed; keep its files')
    } catch (reason) {
      if ((reason as { code?: unknown }).code === 'ENOENT')
        throw new DeliveryTargetConflict(
          'Managed target content is missing; keep remaining files',
        )
      throw reason
    }
    current()
  }
  private async confined(
    host: DeliveryHost,
    root: HostPath,
    path: HostPath,
    current: () => void,
    directory = true,
  ): Promise<void> {
    if (hostPathEquals(root, path) || !containsHostPath(root, path))
      throw new Error('Delivery target must be a contained child of its exact grant')
    if (!hostPathEquals(await host.realpath(root), root))
      throw new Error('Granted root changed')
    current()
    await proveRealProjectDirectory(
      host,
      root,
      root,
      directory ? path : dirnameHostPath(path),
    )
    current()
  }
  private host(path: HostPath): DeliveryHost {
    const host = this.hosts.hostById(path.hostId)
    if (
      !host ||
      host.connectionState !== 'connected' ||
      !host.fileTransfer ||
      !host.managedTransfer
    )
      throw new Error('Delivery host is disconnected or unsupported')
    return host
  }
  private sameHost(host: DeliveryHost, root: HostPath): void {
    if (this.hosts.hostById(root.hostId) !== host || host.connectionState !== 'connected')
      throw new Error('Delivery host custody ended')
  }
  private grant(
    caller: DeliveryCaller,
    id: unknown,
    mode: ExtensionSourceGrant['declaration']['mode'],
  ): ExtensionSourceGrant {
    const grant = this.approvals.get(
      caller.activation,
      extensionText(id, 'delivery grant', 80),
    )
    if (!grant?.root || grant.declaration.mode !== mode)
      throw new Error(
        'Grant exact delivery source and destination scopes in Settings → Extensions',
      )
    return grant
  }
  private sameGrant(caller: DeliveryCaller, grant: ExtensionSourceGrant): void {
    if (this.approvals.get(caller.activation, grant.declaration.id) !== grant)
      throw new Error('Delivery grant was revoked')
  }
  private destination(caller: DeliveryCaller, grant: ExtensionSourceGrant): void {
    if (
      !caller.admitted?.current() ||
      caller.admitted.value.workspace?.id !== grant.workspaceId ||
      !caller.admitted.root ||
      !hostPathEquals(caller.admitted.root, grant.root!)
    )
      throw new Error('Delivery requires its exact admitted registered workspace')
  }
  private captureFor(caller: DeliveryCaller, token: unknown): Capture {
    this.prune()
    this.current(caller)
    const value = typeof token === 'string' ? this.captures.get(token) : undefined
    if (!value || value.released || !this.sameCaller(value.caller, caller))
      throw new Error('Captured payload is stale or belongs to another caller')
    this.sameGrant(caller, value.grant)
    return value
  }
  private sameCaller(a: DeliveryCaller, b: DeliveryCaller): boolean {
    return a.activation === b.activation && a.view === b.view && a.action === b.action
  }
  private current(caller: DeliveryCaller): void {
    if (
      this.disposed ||
      this.failure ||
      this.activations.active.get(caller.activation.installationId) !== caller.activation
    )
      throw new Error(this.failure ?? 'Delivery activation ended')
    caller.current()
    caller.signal.throwIfAborted()
    this.authority.signal.throwIfAborted()
  }
  private async exists(host: DeliveryHost, path: HostPath): Promise<boolean> {
    try {
      await host.stat(path)
      return true
    } catch (reason) {
      if ((reason as { code?: unknown }).code === 'ENOENT') return false
      throw reason
    }
  }
  private async publishJournal(
    next: DeliveryJournal,
    current: () => void,
  ): Promise<void> {
    const revision = this.journalRevision,
      pinned = () => {
        current()
        if (this.journalRevision !== revision)
          throw new Error('Delivery journal changed during persistence')
      }
    pinned()
    await this.activations.saveManagedDeliveries(next, pinned)
    pinned()
    this.state = next
    this.journalRevision = randomUUID()
  }
  private saveOperation(
    operation: DeliveryOperation,
    current: () => void,
  ): Promise<void> {
    return this.serialize(() => {
      const exists = this.state.operations.some((entry) => entry.id === operation.id)
      if (
        !exists &&
        (this.state.operations.length >= DELIVERY_LIMITS.operations ||
          this.state.operations.reduce(
            (n, entry) => n + retainedDeliveryBytes(entry),
            0,
          ) +
            retainedDeliveryBytes(operation) >
            DELIVERY_LIMITS.retainedBytes)
      )
        throw new Error('Retained operation capacity is full')
      proveDeliveryJournalCapacity(this.state, operation)
      const operations = this.state.operations.filter(
        (entry) => entry.id !== operation.id,
      )
      return this.publishJournal(
        { ...this.state, operations: [...operations, structuredClone(operation)] },
        current,
      )
    })
  }
  private prune(): void {
    for (const [id, value] of this.captures)
      try {
        this.current(value.caller)
        if (value.expires <= Date.now()) throw new Error('Expired')
      } catch {
        this.releaseCapture(id, value)
      }
    for (const [id, value] of this.previews)
      try {
        this.current(value.caller)
        if (value.expires <= Date.now()) throw new Error('Expired')
      } catch {
        this.previews.delete(id)
      }
  }
  private releaseCapture(id: string, capture: Capture): void {
    capture.released = true
    for (const [token, preview] of this.previews)
      if (preview.capture === capture) this.previews.delete(token)
    if (!this.physicalCaptures.has(capture)) this.captures.delete(id)
  }
  private checkDomain(value: unknown): void {
    if (Buffer.byteLength(JSON.stringify(value)) > DELIVERY_LIMITS.domainBytes)
      throw new Error('Delivery domain record exceeds its bound')
  }
  domain(caller: DeliveryCaller, value: unknown): Promise<unknown> {
    this.current(caller)
    const request = extensionObject(value),
      id = caller.activation.installationId
    if (request['write'] !== true) {
      const data = this.domains[id] ?? null
      return Promise.resolve(
        deliveryValue({
          value: data,
          revision: createHash('sha256').update(JSON.stringify(data)).digest('hex'),
        }),
      )
    }
    return this.serialize(async () => {
      this.current(caller)
      await this.activations.assertWritable()
      const input = extensionObject(value),
        id = caller.activation.installationId
      if (input['write'] === true && !caller.mutationAllowed)
        throw new Error('Domain writes require admitted action authority')
      const currentValue = this.domains[id] ?? null
      const revision = createHash('sha256')
        .update(JSON.stringify(currentValue))
        .digest('hex')
      if (input['expected'] !== revision)
        throw new Error('Delivery domain changed; inspect again before writing')
      if (
        input['journalRevision'] !== undefined &&
        input['journalRevision'] !== this.journalRevision
      )
        throw new Error('Delivery evidence changed; observe complete records again')
      this.checkDomain(input['value'])
      const next = { ...this.domains, [id]: input['value'] }
      const journalRevision = this.journalRevision
      const pinned = () => {
        this.current(caller)
        if (this.journalRevision !== journalRevision)
          throw new Error('Delivery journal changed during domain persistence')
      }
      await this.activations.saveDeliveryDomain(next, pinned)
      pinned()
      this.domains = next
      return null
    })
  }
  private completeRecovered(
    operation: DeliveryOperation,
    current: () => void,
  ): Promise<void> {
    return this.serialize(() =>
      this.publishJournal(
        completedDeliveryJournal(
          this.state,
          operation,
          this.activations.hasInstallationIdentity(operation.installation),
        ),
        current,
      ),
    )
  }
  reconcile(caller: DeliveryCaller, value: unknown, cleanup = false): Promise<unknown> {
    return this.trackPhysical(
      (async () => {
        const input = extensionObject(value),
          id = extensionText(input['operation'], 'operation', 80)
        this.current(caller)
        if (cleanup && (!caller.mutationAllowed || !caller.effects.delete))
          throw new Error('Cleanup requires admitted delete authority')
        const operation = this.state.operations.find(
          (entry) =>
            entry.id === id && entry.installation === caller.activation.installationId,
        )
        if (!operation)
          throw new Error('This operation does not belong to the current installation')
        const grant = this.grant(caller, input['destination'], 'managed-delivery')
        if (
          !hostPathEquals(grant.root!, operation.root) ||
          grant.workspaceId !== operation.workspace
        )
          throw new Error('Recovery requires the exact destination grant')
        const signal = AbortSignal.any([
          caller.signal,
          this.authority.signal,
          AbortSignal.timeout(
            cleanup ? DELIVERY_LIMITS.cleanupMs : DELIVERY_LIMITS.deadlineMs,
          ),
        ])
        const current = () => {
          signal.throwIfAborted()
          this.current(caller)
          this.sameGrant(caller, grant)
          this.destination(caller, grant)
          caller.authorize(operation.root.hostId, operation.workspace)
        }
        return this.reserveRecovery(operation.target, () =>
          cleanup
            ? this.recovery.cleanup(id, current, signal)
            : this.recovery.reconcile(id, current, signal),
        )
      })(),
    )
  }
  trustedRecovery(
    kind: 'inspect' | 'keep' | 'reconcile' | 'cleanup',
    id: string,
    current: () => void,
    signal: AbortSignal,
  ): Promise<DeliveryRecoveryReply> {
    return this.trackPhysical(
      (async () => {
        const pinned = () => {
          lifetime.throwIfAborted()
          if (this.disposed || this.failure)
            throw new Error(this.failure ?? 'Delivery recovery ended')
          current()
          this.authority.signal.throwIfAborted()
        }
        const lifetime = AbortSignal.any([
          signal,
          this.authority.signal,
          AbortSignal.timeout(
            kind === 'cleanup' ? DELIVERY_LIMITS.cleanupMs : DELIVERY_LIMITS.deadlineMs,
          ),
        ])
        return this.reserveRecovery(this.recovery.target(id, kind === 'keep'), () => {
          if (kind === 'inspect') return this.recovery.inspect(id, pinned, lifetime)
          if (kind === 'keep') return this.recovery.keepFiles(id, pinned, lifetime)
          if (kind === 'cleanup') return this.recovery.cleanup(id, pinned, lifetime)
          return this.recovery.reconcile(id, pinned, lifetime)
        })
      })(),
    )
  }
  forget(installation: string, persisted: unknown) {
    if (this.failure || this.disposed)
      throw new Error(this.failure ?? 'Delivery authority ended')
    const state = readDeliveryJournal(persisted)
    const journal = {
      ...state,
      records: state.records.filter(
        (entry) => entry.record.installation !== installation,
      ),
    }
    return {
      journal,
      commitJournal: () => {
        this.state = journal
        this.journalRevision = randomUUID()
      },
      commitDomain: () => {
        delete this.domains[installation]
      },
    } // Operation evidence survives; cache publication follows each durable write.
  }
  revoke(installation: string): void {
    for (const [id, value] of this.captures)
      if (value.caller.activation.installationId === installation)
        this.releaseCapture(id, value)
    for (const [id, value] of this.previews)
      if (value.caller.activation.installationId === installation)
        this.previews.delete(id)
  }
  dispose(): Promise<void> {
    this.disposed = true
    this.captures.clear()
    this.previews.clear()
    this.authority.abort()
    this.recovery.dispose()
    return Promise.allSettled([
      this.pending,
      ...this.captureWork,
      ...this.physicalWork,
    ]).then(() => undefined)
  }
  private trackPhysical<T>(work: Promise<T>): Promise<T> {
    this.physicalWork.add(work)
    return work.finally(() => this.physicalWork.delete(work))
  }
  private async reserveRecovery<T>(target: HostPath, task: () => Promise<T>): Promise<T> {
    const key = JSON.stringify(target)
    if (this.physical.has(key) || this.physical.size >= DELIVERY_LIMITS.concurrent)
      throw new Error('This target or physical recovery capacity is busy')
    this.physical.add(key)
    try {
      return await task()
    } finally {
      this.physical.delete(key)
    }
  }
  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.pending.then(operation)
    this.pending = result.catch(() => undefined)
    return result
  }
}
