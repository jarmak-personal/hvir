import { randomUUID } from 'node:crypto'
import {
  dirnameHostPath,
  hostPathEquals,
  joinHostPath,
  type HostPath,
} from '../../shared/host-path'
import {
  DELIVERY_LIMITS,
  type DeliveryRecoveryReply,
} from '../../shared/extensions/managed-delivery'
import { proveRealProjectDirectory } from '../project-file-operations/project-file-confinement'
import { deliveryFingerprint, readDeliveryTree, type DeliveryHost } from './delivery-tree'
import type { DeliveryJournal, DeliveryOperation } from './delivery-journal'
import { deliveryValue } from './delivery-message'

interface ObjectFacts {
  readonly path: HostPath
  readonly state: 'absent' | 'present' | 'unverifiable'
  readonly identity?: string
  readonly fingerprint?: string
  readonly recordedIdentity?: string
}
export interface DeliveryRecoveryPorts {
  journal(): DeliveryJournal
  host(path: HostPath): DeliveryHost | undefined
  writable(): Promise<void>
  resolve(
    operation: DeliveryOperation,
    forgetAuthority: boolean,
    current: () => void,
  ): Promise<void>
  complete(operation: DeliveryOperation, current: () => void): Promise<void>
}
/** Exact persisted custody and deliberate keep-files resolution, independent of package demand. */
export class DeliveryRecovery {
  private readonly decisions = new Map<
    string,
    { id: string; facts: string; expires: number }
  >()
  private disposed = false
  constructor(private readonly ports: DeliveryRecoveryPorts) {}
  private operation(id: string): DeliveryOperation {
    if (this.disposed) throw new Error('Delivery recovery ended')
    const operation = this.ports.journal().operations.find((entry) => entry.id === id)
    if (!operation) throw new Error('Choose a current exact recorded delivery operation')
    return operation
  }
  private async facts(
    operation: DeliveryOperation,
    current: () => void,
    signal: AbortSignal,
  ): Promise<ObjectFacts[]> {
    const paths = [
      operation.target,
      operation.stage,
      operation.preserve,
      ...operation.parents.map((entry) => entry.path),
    ]
    const recorded = (path: HostPath): Pick<ObjectFacts, 'path' | 'recordedIdentity'> => {
      const parent = operation.parents.find((entry) => hostPathEquals(entry.path, path))
      const identity = parent
        ? parent.identity
        : hostPathEquals(path, operation.stage)
          ? operation.stageIdentity
          : hostPathEquals(path, operation.preserve)
            ? (operation.preserveIdentity ?? operation.previous?.identity)
            : ['publishing', 'completed'].includes(operation.phase)
              ? operation.stageIdentity
              : operation.previous?.identity
      return { path, ...(identity ? { recordedIdentity: identity } : {}) }
    }
    const host = this.ports.host(operation.root)
    if (
      !host ||
      host.connectionState !== 'connected' ||
      !host.managedTransfer ||
      !host.fileTransfer
    )
      return paths.map((path) => ({ ...recorded(path), state: 'unverifiable' }))
    const result: ObjectFacts[] = []
    for (const path of paths) {
      current()
      signal.throwIfAborted()
      try {
        if (!hostPathEquals(await host.realpath(operation.root), operation.root))
          throw new Error('Root changed')
        await proveRealProjectDirectory(
          host,
          operation.root,
          operation.root,
          dirnameHostPath(path),
        )
        const identity = await host.managedTransfer.entryIdentity(path, signal)
        if (operation.parents.some((entry) => hostPathEquals(entry.path, path))) {
          result.push({ ...recorded(path), state: 'present', identity })
          continue
        }
        const tree = await readDeliveryTree(
          host,
          path,
          current,
          signal,
          false,
          operation.root,
        )
        if ((await host.managedTransfer.entryIdentity(path, signal)) !== identity)
          throw new Error('Object changed')
        current()
        signal.throwIfAborted()
        result.push({
          ...recorded(path),
          state: 'present',
          identity,
          fingerprint: tree.fingerprint,
        })
      } catch (reason) {
        current()
        signal.throwIfAborted()
        result.push({
          ...recorded(path),
          state:
            (reason as { code?: unknown }).code === 'ENOENT' ? 'absent' : 'unverifiable',
        })
      }
    }
    return result
  }
  async inspect(
    id: string,
    current: () => void,
    signal: AbortSignal,
  ): Promise<DeliveryRecoveryReply> {
    await this.ports.writable()
    current()
    const operation = this.operation(id),
      facts = await this.facts(operation, current, signal)
    for (const [token, decision] of this.decisions)
      if (decision.expires <= Date.now()) this.decisions.delete(token)
    if (this.decisions.size >= 8)
      throw new Error('Pending recovery decisions are full; inspect again after expiry')
    const token = randomUUID()
    const result = deliveryValue({
      token,
      operation: operation.id,
      installation: operation.installation,
      phase: operation.phase,
      completion:
        operation.phase === 'completed'
          ? 'proven'
          : operation.phase === 'conflicted'
            ? 'conflicted'
            : 'unproven',
      objects: facts,
      resolution:
        'Keep every file in place and end delivery tracking. This neither completes nor cleans an uncertain delivery.',
    })
    this.decisions.set(token, {
      id,
      facts: JSON.stringify(facts),
      expires: Date.now() + 60_000,
    })
    return result
  }
  async keepFiles(
    token: string,
    current: () => void,
    signal: AbortSignal,
  ): Promise<DeliveryRecoveryReply> {
    await this.ports.writable()
    current()
    const decision = this.decisions.get(token)
    this.decisions.delete(token)
    if (!decision || decision.expires <= Date.now())
      throw new Error('Inspect exact retained objects again before ending tracking')
    const operation = this.operation(decision.id)
    if (JSON.stringify(await this.facts(operation, current, signal)) !== decision.facts)
      throw new Error('Retained object facts changed; inspect them again')
    current()
    signal.throwIfAborted()
    await this.ports.resolve(operation, true, current)
    return {
      outcome: 'resolved-by-retaining-files',
      completion:
        operation.phase === 'completed'
          ? 'proven'
          : operation.phase === 'conflicted'
            ? 'conflicted'
            : 'unproven',
      files:
        'All objects stay in place. hvir no longer updates, removes or cleans this delivery.',
    }
  }
  async reconcile(
    id: string,
    current: () => void,
    signal: AbortSignal,
  ): Promise<DeliveryRecoveryReply> {
    await this.ports.writable()
    current()
    const operation = this.operation(id),
      facts = await this.facts(operation, current, signal)
    if (operation.phase === 'conflicted')
      return deliveryValue({
        operation: id,
        outcome: 'conflicted',
        objects: facts,
        replayed: false,
        reason:
          'A destination conflict was established. Preserve the exact objects; inspect before deliberate resolution.',
      })
    if (operation.phase === 'completed')
      return deliveryValue({
        operation: id,
        outcome: 'completed',
        objects: facts,
        replayed: false,
        reason:
          'This operation completed durably; later target changes do not change its historical outcome or newer authority.',
      })
    const [target, stage, preserved] = facts
    const previousOwned =
      !operation.previous ||
      (preserved?.state === 'present' &&
        preserved.identity === operation.previous.identity &&
        preserved.fingerprint === deliveryFingerprint(operation.previousTree!))
    const published =
      operation.kind !== 'remove' &&
      ['publishing', 'completed'].includes(operation.phase) &&
      operation.stageIdentity &&
      target?.state === 'present' &&
      target.identity === operation.stageIdentity &&
      target.fingerprint === deliveryFingerprint(operation.payload) &&
      stage?.state === 'absent' &&
      previousOwned
    const removed =
      operation.kind === 'remove' &&
      ['displacing', 'displaced', 'completed'].includes(operation.phase) &&
      target?.state === 'absent' &&
      previousOwned
    if (published || removed) {
      current()
      signal.throwIfAborted()
      await this.ports.complete(operation, current)
      return deliveryValue({
        operation: id,
        outcome: 'completed',
        objects: facts,
        replayed: false,
      })
    }
    return deliveryValue({
      operation: id,
      outcome: 'uncertain',
      objects: facts,
      replayed: false,
      reason:
        'Completion or custody is unproven. Inspect these exact objects; keep files or resolve them in Files.',
    })
  }
  async cleanup(
    id: string,
    current: () => void,
    signal: AbortSignal,
  ): Promise<DeliveryRecoveryReply> {
    await this.ports.writable()
    current()
    const operation = this.operation(id),
      host = this.ports.host(operation.root)
    if (
      !host?.fileTransfer ||
      !host.managedTransfer ||
      host.connectionState !== 'connected'
    )
      throw new Error('Recorded delivery host is unreachable; retain its objects')
    const reconciliation = (await this.reconcile(id, current, signal)) as {
      outcome: string
    }
    if (reconciliation.outcome !== 'completed')
      throw new Error(
        'Reconcile completion before cleanup; uncertain objects remain protected',
      )
    const facts = await this.facts(operation, current, signal)
    const owned = [
      { fact: facts[1]!, identity: operation.stageIdentity, entries: operation.payload },
      {
        fact: facts[2]!,
        identity: operation.preserveIdentity ?? operation.previous?.identity,
        entries: operation.previousTree ?? [],
      },
    ]
    for (const { fact, identity, entries } of owned)
      if (
        fact.state !== 'absent' &&
        (fact.state !== 'present' ||
          !identity ||
          fact.identity !== identity ||
          fact.fingerprint !== deliveryFingerprint(entries))
      )
        throw new Error(
          'Retained object changed or custody is unproven; keep it for deliberate resolution',
        )
    let removed = 0
    try {
      for (const { fact, identity, entries } of owned) {
        if (fact.state === 'absent') continue
        for (const entry of [...entries].sort(
          (a, b) =>
            b.path.split('/').length - a.path.split('/').length ||
            b.path.localeCompare(a.path),
        )) {
          current()
          signal.throwIfAborted()
          if ((await host.managedTransfer.entryIdentity(fact.path, signal)) !== identity)
            throw new Error('Retained directory identity changed')
          await proveRealProjectDirectory(
            host,
            operation.root,
            operation.root,
            dirnameHostPath(fact.path),
          )
          const path = entry.path ? joinHostPath(fact.path, entry.path) : fact.path
          await proveRealProjectDirectory(
            host,
            operation.root,
            operation.root,
            dirnameHostPath(path),
          )
          if (entry.type === 'dir') {
            const metadata = await host.stat(path)
            current()
            signal.throwIfAborted()
            if (metadata.type !== 'dir' || (metadata.mode & 0o7777) !== entry.mode)
              throw new Error('Retained directory changed during cleanup')
            await host.fileTransfer.removeDirectory(path)
          } else {
            const metadata = await host.stat(path)
            const hash = await readDeliveryTree(
              host,
              path,
              current,
              signal,
              false,
              operation.root,
            )
            if (
              hash.entries.length !== 1 ||
              hash.entries[0]?.sha256 !== entry.sha256 ||
              hash.entries[0]?.mode !== entry.mode ||
              hash.entries[0]?.size !== entry.size
            )
              throw new Error('Retained file changed during cleanup')
            current()
            signal.throwIfAborted()
            await proveRealProjectDirectory(
              host,
              operation.root,
              operation.root,
              dirnameHostPath(path),
            )
            if (
              (await host.managedTransfer.entryIdentity(fact.path, signal)) !== identity
            )
              throw new Error('Retained directory identity changed')
            await host.removeFile(path, { expectedMtimeMs: metadata.mtimeMs })
          }
          removed++
          if (removed > DELIVERY_LIMITS.files * 2)
            throw new Error('Cleanup entry capacity exceeded')
        }
      }
      await this.ports.resolve(operation, false, current)
      return {
        operation: id,
        outcome: 'cleanup-completed',
        removed,
        target: 'Target files remain unchanged',
      }
    } catch {
      return {
        operation: id,
        outcome: 'cleanup-uncertain',
        removed,
        reason:
          'Cleanup stopped. Exact remaining objects and their records are retained; inspect before resolving.',
      }
    }
  }
  dispose(): void {
    this.disposed = true
    this.decisions.clear()
  }
  target(id: string, decision = false): HostPath {
    return this.operation(decision ? (this.decisions.get(id)?.id ?? '') : id).target
  }
}
