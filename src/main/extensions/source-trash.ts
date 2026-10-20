import { randomUUID } from 'node:crypto'
import { containsHostPath, hostPathEquals, LOCAL_HOST_ID } from '../../shared/host-path'
import { extensionId, extensionObject } from '../../shared/extensions/validation'
import { SOURCE_LIMITS } from '../../shared/extensions/source-access'
import type {
  ExtensionSourceTrashProposal,
  ExtensionSourceTrashResult,
} from '../../shared/extensions/source-trash'
import type {
  ProjectFileOperationProgress,
  ProjectFileOperationResult,
  ProjectFileOperationStartResult,
} from '../../shared/project-file-operations'
import { proveProjectEntry } from '../project-file-operations/project-file-confinement'
import type { ProjectHost } from '../project-host/project-host'
import type { ProjectFileOperationCoordinator } from '../project-file-operations'
import type { RendererOwner, RendererResourceScopes } from '../renderer-resource-scopes'
import { readSourcePath, type ExtensionSourceApprovalOwner } from './source-approval'
import type { SourceCaller } from './source-reading'

interface SourceTrashHost extends Pick<
  ProjectHost,
  'hostId' | 'connectionState' | 'realpath' | 'stat'
> {
  readonly managedTransfer?: Pick<
    NonNullable<ProjectHost['managedTransfer']>,
    'entryIdentity'
  >
  readonly fileDeletion: Pick<ProjectHost['fileDeletion'], 'capability'>
}

interface TrashRequest {
  readonly owner: RendererOwner
  readonly proposal: ExtensionSourceTrashProposal
  readonly controller: AbortController
  readonly signal: AbortSignal
  readonly current: () => void
  readonly validate: () => Promise<void>
  readonly settle: (result: ExtensionSourceTrashResult, physical?: boolean) => void
  readonly stopDecisionDeadline: () => void
  cancelOperation?: () => void
  visible: boolean
  consumed: boolean
  submitted: boolean
  physical: boolean
}

/** Requests Files' human decision; read grants never authorize the physical operation. */
export class ExtensionSourceTrashRequestOwner {
  private pending?: TrashRequest
  private disposed = false

  constructor(
    private readonly scopes: Pick<RendererResourceScopes, 'assertCurrent'>,
    private readonly approvals: ExtensionSourceApprovalOwner,
    private readonly localHost: SourceTrashHost,
    private readonly foreground: (owner: RendererOwner) => boolean,
    private readonly publish: (
      owner: RendererOwner,
      proposals: readonly ExtensionSourceTrashProposal[],
    ) => void,
  ) {}

  async request(
    caller: SourceCaller,
    value: unknown,
    owner: RendererOwner,
  ): Promise<ExtensionSourceTrashResult> {
    if (!caller.allowed) throw new Error('Trash review requires an ordinary human view')
    const input = extensionObject(value)
    const source = extensionId(input['source']),
      path = readSourcePath(input['path']),
      context = caller.context(),
      grant = this.approvals.get(caller.activation, source, context)
    if (
      !grant?.root ||
      !context?.root ||
      !grant.workspaceId ||
      grant.declaration.mode !== 'read-only' ||
      grant.declaration.context !== 'workspace' ||
      input['workspaceId'] !== grant.workspaceId ||
      context.value.workspace?.id !== grant.workspaceId ||
      !hostPathEquals(context.root, grant.root) ||
      !containsHostPath(grant.root, path) ||
      hostPathEquals(grant.root, path)
    )
      throw new Error('Trash review requires an exact granted project directory')
    const root = grant.root,
      host = this.localHost
    if (
      root.hostId !== LOCAL_HOST_ID ||
      host.fileDeletion.capability !== 'recoverable' ||
      !host.managedTransfer
    )
      return {
        outcome: 'refused',
        reason:
          'Recoverable Trash is unavailable on this host. Use Files to inspect its supported actions.',
      }
    const transfer = host.managedTransfer
    if (this.disposed || this.pending) throw new Error('Another Trash review is pending')
    const controller = new AbortController(),
      signal = AbortSignal.any([caller.signal, controller.signal])
    let identity: string | undefined, rootIdentity: string | undefined
    const current = () => {
      signal.throwIfAborted()
      caller.current()
      this.scopes.assertCurrent(owner)
      if (
        this.disposed ||
        !this.foreground(owner) ||
        !context.current() ||
        host.connectionState !== 'connected' ||
        !Object.is(this.approvals.hosts.hostById(root.hostId), host) ||
        this.approvals.get(caller.activation, source, caller.context()) !== grant ||
        caller.context()?.value.workspace?.id !== grant.workspaceId ||
        !caller.context()?.root ||
        !hostPathEquals(caller.context()!.root!, root)
      )
        throw new Error('Trash review source or workspace changed')
    }
    const validate = async () => {
      current()
      if (
        host.fileDeletion.capability !== 'recoverable' ||
        !hostPathEquals(await host.realpath(root), root)
      )
        throw new Error('Trash recovery or workspace root changed')
      current()
      const entry = await proveProjectEntry(host, root, root, path)
      current()
      if (entry.type !== 'dir' || !hostPathEquals(entry.canonicalPath, path))
        throw new Error('Trash review requires the selected ordinary directory')
      const observedRoot = await transfer.entryIdentity(root, signal)
      current()
      if (rootIdentity !== undefined && rootIdentity !== observedRoot)
        throw new Error('The workspace directory changed. Review it again.')
      rootIdentity = observedRoot
      const observed = await transfer.entryIdentity(path, signal)
      current()
      if (identity !== undefined && observed !== identity)
        throw new Error('The selected directory changed. Review it again.')
      identity = observed
    }
    current()
    return new Promise<ExtensionSourceTrashResult>((resolve) => {
      const aborted = () => {
        try {
          entry.cancelOperation?.()
        } catch {
          /* Files already revokes retired renderers. */
        }
        entry.settle({
          outcome: entry.submitted ? 'uncertain' : 'cancelled',
          reason: 'Trash review ended. No automatic retry was made.',
        })
      }
      const entry: TrashRequest = {
        owner,
        controller,
        signal,
        current,
        validate,
        proposal: {
          id: randomUUID(),
          name: caller.activation.revision.manifest.name,
          workspaceId: grant.workspaceId!,
          root,
          path,
        },
        visible: false,
        consumed: false,
        submitted: false,
        physical: true,
        stopDecisionDeadline: () => clearTimeout(timer),
        settle: (result, physical = false) => {
          resolve(result)
          if (entry.visible) {
            entry.visible = false
            try {
              this.publish(owner, [])
            } catch {
              /* The owning renderer may already be gone. */
            }
          }
          if (physical || !entry.physical) {
            clearTimeout(timer)
            signal.removeEventListener('abort', aborted)
            if (this.pending === entry) this.pending = undefined
          }
        },
      }
      this.pending = entry
      signal.addEventListener('abort', aborted, { once: true })
      const timer = setTimeout(
        () => controller.abort(new Error('Trash request expired')),
        SOURCE_LIMITS.decisionMs,
      )
      void validate()
        .then(() => {
          current()
          if (this.pending !== entry) return
          entry.physical = false
          entry.visible = true
          this.publish(owner, [entry.proposal])
        })
        .catch((reason: unknown) =>
          entry.settle(
            {
              outcome: signal.aborted ? 'cancelled' : 'refused',
              reason: message(reason),
            },
            true,
          ),
        )
    })
  }

  snapshot(owner: RendererOwner): readonly ExtensionSourceTrashProposal[] {
    const entry = this.pending
    return entry?.visible && sameOwner(entry.owner, owner) ? [entry.proposal] : []
  }

  async confirm(
    owner: RendererOwner,
    id: string,
    files: Pick<ProjectFileOperationCoordinator, 'delete' | 'cancel'>,
    publish: (progress: ProjectFileOperationProgress) => void,
  ): Promise<ProjectFileOperationStartResult> {
    const entry = this.require(owner, id)
    if (entry.consumed) throw new Error('Trash review was already confirmed')
    entry.current()
    entry.consumed = true
    // Retain admission through preparation and physical settlement, even after revocation.
    entry.physical = true
    try {
      await entry.validate()
      const started = await files.delete({
        owner,
        request: {
          workspaceRoot: entry.proposal.root,
          source: entry.proposal.path,
          confirmedRecovery: 'recoverable',
        },
        beforeDelete: entry.validate,
        onSubmitted: () => {
          // The source can end after async validation but before Files' start reply.
          entry.current()
          entry.submitted = true
          entry.stopDecisionDeadline()
        },
        publish,
        settled: (result) => entry.settle(outcome(result), true),
      })
      if (started.outcome === 'busy')
        entry.settle({ outcome: 'refused', reason: started.reason }, true)
      else {
        entry.stopDecisionDeadline()
        entry.cancelOperation = () => {
          files.cancel(owner, started.operationId, started.generation)
        }
        if (entry.signal.aborted) {
          try {
            entry.cancelOperation()
          } catch {
            /* The renderer may already be retired. */
          }
        }
      }
      return started
    } catch (reason) {
      entry.settle(
        {
          outcome: entry.submitted
            ? 'uncertain'
            : entry.signal.aborted
              ? 'cancelled'
              : 'refused',
          reason: message(reason),
        },
        true,
      )
      throw reason
    }
  }

  cancel(owner: RendererOwner, id: string): void {
    this.require(owner, id).controller.abort(new Error('Trash review cancelled'))
  }
  revalidate(): void {
    try {
      this.pending?.current()
    } catch {
      this.pending?.controller.abort(new Error('Trash review was revoked'))
    }
  }
  dispose(): void {
    this.disposed = true
    this.revalidate()
  }
  private require(owner: RendererOwner, id: string): TrashRequest {
    const entry = this.pending
    if (!entry?.visible || entry.proposal.id !== id || !sameOwner(entry.owner, owner))
      throw new Error('Trash review is no longer current')
    return entry
  }
}

function outcome(result?: ProjectFileOperationResult): ExtensionSourceTrashResult {
  const item = result?.outcome === 'completed' ? result.items[0] : undefined
  if (item?.status === 'completed' && item.effect === 'trashed-entry')
    return { outcome: 'completed' }
  return {
    outcome:
      !item || item.effect === 'deletion-state-unknown'
        ? 'uncertain'
        : item.status === 'cancelled'
          ? 'cancelled'
          : 'refused',
    reason: item?.reason ?? 'Trash completion could not be verified.',
  }
}
function sameOwner(a: RendererOwner, b: RendererOwner): boolean {
  return a.id === b.id && a.generation === b.generation
}
function message(reason: unknown): string {
  return (reason instanceof Error ? reason.message : 'Trash review failed').slice(0, 240)
}
