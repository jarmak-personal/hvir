import { hostPathEquals } from '../../shared/host-path'
import {
  SOURCE_LIMITS,
  type ExtensionSourceRequestProposal,
  type ExtensionSourceRequestResult,
} from '../../shared/extensions/source-access'
import { extensionId, extensionObject } from '../../shared/extensions/validation'
import type { RendererOwner, RendererResourceScopes } from '../renderer-resource-scopes'
import { readSourcePath, type ExtensionSourceApprovalOwner } from './source-approval'
import type { SourceCaller } from './source-reading'

interface SourceDecision {
  readonly owner: RendererOwner
  readonly controller: AbortController
  readonly current: () => void
  proposal?: ExtensionSourceRequestProposal
  settle?: (accepted: boolean) => void
}

/** In-context consent transport; canonical preparation and all grants stay with approvals. */
export class ExtensionSourceRequestOwner {
  private readonly pending = new Set<SourceDecision>()
  private disposed = false
  constructor(
    private readonly scopes: Pick<RendererResourceScopes, 'assertCurrent'>,
    private readonly approvals: Pick<
      ExtensionSourceApprovalOwner,
      'prepare' | 'approve' | 'cancelPrepared' | 'hasPrepared' | 'get'
    >,
    private readonly foreground: (owner: RendererOwner) => boolean,
    private readonly publish: (
      owner: RendererOwner,
      proposals: readonly ExtensionSourceRequestProposal[],
    ) => void,
  ) {}

  async request(
    caller: SourceCaller,
    value: unknown,
    owner: RendererOwner,
  ): Promise<ExtensionSourceRequestResult> {
    if (!caller.allowed)
      throw new Error('Read access requires an ordinary human-selected view')
    const input = extensionObject(value)
    if (Object.keys(input).some((key) => !['source', 'root'].includes(key)))
      throw new Error('Request a declared application source and its local root only')
    const source = extensionId(input['source'])
    const declaration = caller.activation.revision.manifest.access.find(
      (entry) => entry.id === source,
    )
    if (declaration?.context !== 'application' || declaration.mode !== 'read-only')
      throw new Error(
        'In-context requests cover application-local read-only sources only',
      )
    const controller = new AbortController()
    const signal = AbortSignal.any([caller.signal, controller.signal])
    let proposalToken: string | undefined
    const current = (): void => {
      signal.throwIfAborted()
      caller.current()
      this.scopes.assertCurrent(owner)
      if (this.disposed || !this.foreground(owner))
        throw new Error('Read access request ended')
      if (proposalToken && !this.approvals.hasPrepared(proposalToken))
        throw new Error('Read access decision was revoked')
    }
    current()
    const pending: SourceDecision = { owner, controller, current }
    this.pending.add(pending)
    let token: string | undefined
    const retire = (): void => {
      if (token) this.approvals.cancelPrepared(token)
      if (!pending.proposal) return
      proposalToken = undefined
      delete pending.proposal
      delete pending.settle
      this.publish(owner, this.snapshot(owner))
    }
    signal.addEventListener('abort', retire)
    const deadline = setTimeout(
      () => controller.abort(new Error('Read access decision expired')),
      SOURCE_LIMITS.decisionMs,
    )
    try {
      const prepared = await this.approvals.prepare(
        {
          installationId: caller.activation.installationId,
          source,
          root: readSourcePath(input['root']),
        },
        current,
      )
      token = prepared.token
      current()
      const existing = this.approvals.get(caller.activation, source)
      if (
        existing?.root &&
        prepared.grant.root &&
        hostPathEquals(existing.root, prepared.grant.root)
      )
        return { granted: true }
      pending.proposal = {
        id: token,
        name: caller.activation.revision.manifest.name,
        source,
        description: declaration.description,
        root: prepared.grant.root!,
      }
      proposalToken = token
      let abort!: () => void
      const decision = new Promise<boolean>((resolve, reject) => {
        abort = () =>
          reject(
            signal.reason instanceof Error
              ? signal.reason
              : new Error('Read access request ended'),
          )
        pending.settle = resolve
        signal.addEventListener('abort', abort, { once: true })
      })
      // Publication can throw before the await; the same promise still owns cancellation.
      void decision.catch(() => undefined)
      try {
        current()
        this.publish(owner, this.snapshot(owner))
        const accepted = await decision
        proposalToken = undefined
        current()
        if (!accepted) return { granted: false }
        // Await the owning physical write; cancellation cannot prove its rollback.
        await this.approvals.approve(token)
        current()
        return { granted: true }
      } finally {
        signal.removeEventListener('abort', abort)
      }
    } finally {
      clearTimeout(deadline)
      signal.removeEventListener('abort', retire)
      retire()
      if (token) this.approvals.cancelPrepared(token)
      this.pending.delete(pending)
      controller.abort()
    }
  }

  snapshot(owner: RendererOwner): readonly ExtensionSourceRequestProposal[] {
    return [...this.pending].flatMap((entry) =>
      sameOwner(entry.owner, owner) && entry.proposal ? [entry.proposal] : [],
    )
  }
  decide(owner: RendererOwner, id: string, accepted: boolean): void {
    const entry = [...this.pending].find(
      (entry) => entry.proposal?.id === id && sameOwner(entry.owner, owner),
    )
    if (!entry?.settle || typeof accepted !== 'boolean')
      throw new Error('Read access decision is no longer current')
    entry.current()
    const settle = entry.settle
    delete entry.proposal
    delete entry.settle
    try {
      this.publish(owner, this.snapshot(owner))
    } catch (reason) {
      entry.controller.abort(reason)
      throw reason
    }
    settle(accepted)
  }
  revalidate(): void {
    for (const entry of this.pending) {
      try {
        entry.current()
      } catch {
        entry.controller.abort(new Error('Read access request ended'))
      }
    }
  }
  dispose(): void {
    this.disposed = true
    this.revalidate()
  }
}
function sameOwner(a: RendererOwner, b: RendererOwner): boolean {
  return a.id === b.id && a.generation === b.generation
}
