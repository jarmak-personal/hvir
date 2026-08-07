import { randomUUID } from 'node:crypto'

import {
  DOCUMENT_REVIEW_LIMITS,
  hostPathEquals,
  type DocumentReviewDeliveryDestination,
  type DocumentReviewDeliveryPayload,
  type DocumentReviewPreviewRequest,
  type DocumentReviewDeliveryScopeRequest,
  type DocumentReviewDeliverySelection,
  type DocumentReviewInsertResult,
  type DocumentReviewPrepareRequest,
  type PreparedDocumentReviewDelivery,
} from '../../shared'
import type {
  HarnessDocumentReviewInsertContract,
  HarnessProviderRegistry,
} from '../harness/harness-provider'
import type { ManagedPty, PtySupervisor } from '../pty/pty-supervisor'
import type {
  RendererOwner,
  RendererResourceLease,
  RendererResourceScopes,
} from '../renderer-resource-scopes'
import type {
  OwnedTerminalSession,
  TerminalSessionStore,
} from '../terminal/session-registry'
import type {
  DocumentReviewCoordinator,
  DocumentReviewDeliveryWorkspaceSnapshot,
} from './document-review-coordinator'
import { prepareDocumentReviewDeliveryPayload } from './document-review-delivery-policy'

interface PreparedRecord {
  readonly id: string
  readonly owner: RendererOwner
  readonly scope: DocumentReviewDeliveryScopeRequest
  readonly selection: DocumentReviewDeliverySelection
  readonly reviewRevision: number
  readonly payload: DocumentReviewDeliveryPayload
  readonly destination: DocumentReviewDeliveryDestination
  readonly contractRevision: number
  readonly terminal: Pick<
    ManagedPty,
    | 'id'
    | 'instanceId'
    | 'ownerId'
    | 'ownerGeneration'
    | 'hostId'
    | 'workspaceRoot'
    | 'providerId'
  >
  lease?: RendererResourceLease
}

export interface DocumentReviewDeliveryCoordinatorOptions {
  readonly workspace: Pick<DocumentReviewCoordinator, 'deliverySnapshot'>
  readonly ptys: Pick<PtySupervisor, 'get' | 'list' | 'write'>
  readonly sessions: Pick<TerminalSessionStore, 'get'>
  readonly providers: Pick<HarnessProviderRegistry, 'get'>
  readonly resources: Pick<RendererResourceScopes, 'register'>
}

/** Owns explicit prepared destination authority and the one PTY write for review insert. */
export class DocumentReviewDeliveryCoordinator {
  private readonly prepared = new Map<string, PreparedRecord>()
  private disposed = false

  constructor(private readonly options: DocumentReviewDeliveryCoordinatorOptions) {}

  preview(
    owner: RendererOwner,
    request: DocumentReviewPreviewRequest,
  ): DocumentReviewDeliveryPayload {
    return payloadFor(this.reviewSnapshot(owner, request), request.selection)
  }

  destinations(
    owner: RendererOwner,
    scope: DocumentReviewDeliveryScopeRequest,
  ): readonly DocumentReviewDeliveryDestination[] {
    const review = this.reviewSnapshot(owner, scope)
    if (review.host.connectionState !== 'connected') return []
    return this.options.ptys
      .list()
      .filter((terminal) => this.sameOwnedWorkspace(terminal, owner, scope))
      .map((terminal) => this.describe(terminal, this.options.sessions.get(terminal.id)))
      .toSorted((left, right) =>
        left.title.localeCompare(right.title) || left.terminalId.localeCompare(right.terminalId),
      )
  }

  prepare(
    owner: RendererOwner,
    request: DocumentReviewPrepareRequest,
  ): PreparedDocumentReviewDelivery {
    const review = this.reviewSnapshot(owner, request)
    this.assertHostConnected(review)
    const payload = payloadFor(review, request.selection)
    const terminal = this.requireDestination(request.terminalId, owner, request)
    const contract = this.insertContract(terminal)
    if (!contract) {
      throw new Error('The selected provider remains Copy-only')
    }
    const destination = this.describe(
      terminal,
      this.options.sessions.get(terminal.id),
    )
    const id = randomUUID()
    const record: PreparedRecord = {
      id,
      owner,
      scope: {
        workspace: request.workspace,
        workspaceGeneration: request.workspaceGeneration,
      },
      selection: request.selection,
      reviewRevision: review.revision,
      payload,
      destination,
      contractRevision: contract.revision,
      terminal: terminalSnapshot(terminal),
    }
    const key = ownerKey(owner)
    this.revokePrepared(this.prepared.get(key))
    this.prepared.set(key, record)
    try {
      record.lease = this.options.resources.register(
        owner,
        {
          lifetime: 'workspace',
          type: 'document-review-delivery',
          root: request.workspace.root,
          id,
        },
        () => this.revokePrepared(record),
      )
    } catch (error) {
      this.prepared.delete(key)
      throw error
    }
    return { id, destination, payload }
  }

  insert(owner: RendererOwner, preparedId: string): DocumentReviewInsertResult {
    this.assertActive()
    const key = ownerKey(owner)
    const prepared = this.prepared.get(key)
    if (!prepared || prepared.id !== preparedId || !sameOwner(prepared.owner, owner)) {
      throw new Error('The prepared review destination is stale')
    }
    const review = this.reviewSnapshot(owner, prepared.scope)
    this.assertHostConnected(review)
    if (review.revision !== prepared.reviewRevision) {
      throw new Error('The review batch changed after preview')
    }
    const payload = payloadFor(review, prepared.selection)
    if (!samePayload(payload, prepared.payload)) {
      throw new Error('The review payload changed after preview')
    }
    if (payload.byteLength > DOCUMENT_REVIEW_LIMITS.deliveryPayloadBytes) {
      throw new Error('The review delivery exceeds its outbound byte limit')
    }
    const terminal = this.options.ptys.get(prepared.terminal.id)
    if (!terminal || !sameTerminal(terminal, prepared.terminal)) {
      throw new Error('The prepared review terminal is no longer live')
    }
    const provider = this.options.providers.get(terminal.providerId)
    const contract = provider.documentReviewInsert
    if (
      !contract ||
      contract.revision !== prepared.contractRevision ||
      terminal.capabilities.reviewInsertContractRevision !== contract.revision ||
      prepared.destination.capability !== 'insert'
    ) {
      throw new Error('The prepared provider insertion capability changed')
    }
    const transport = contract.terminalInput(payload.body)
    this.options.ptys.write(
      terminal.id,
      owner.id,
      transport,
      owner.generation,
    )
    this.revokePrepared(prepared)
    return { outcome: 'inserted' }
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    for (const record of this.prepared.values()) this.revokePrepared(record)
  }

  private reviewSnapshot(
    owner: RendererOwner,
    scope: DocumentReviewDeliveryScopeRequest,
  ): DocumentReviewDeliveryWorkspaceSnapshot {
    this.assertActive()
    return this.options.workspace.deliverySnapshot(owner, scope)
  }

  private assertHostConnected(review: DocumentReviewDeliveryWorkspaceSnapshot): void {
    if (review.host.connectionState !== 'connected') {
      throw new Error('The review workspace host is disconnected')
    }
  }

  private requireDestination(
    terminalId: string,
    owner: RendererOwner,
    scope: DocumentReviewDeliveryScopeRequest,
  ): ManagedPty {
    const terminal = this.options.ptys.get(terminalId)
    if (!terminal || !this.sameOwnedWorkspace(terminal, owner, scope)) {
      throw new Error('The selected review terminal is not live in this workspace')
    }
    return terminal
  }

  private sameOwnedWorkspace(
    terminal: ManagedPty,
    owner: RendererOwner,
    scope: DocumentReviewDeliveryScopeRequest,
  ): boolean {
    return (
      terminal.ownerId === owner.id &&
      terminal.ownerGeneration === owner.generation &&
      terminal.hostId === scope.workspace.root.hostId &&
      hostPathEquals(terminal.workspaceRoot, scope.workspace.root)
    )
  }

  private describe(
    terminal: ManagedPty,
    presentation: OwnedTerminalSession | undefined,
  ): DocumentReviewDeliveryDestination {
    const provider = this.options.providers.get(terminal.providerId)
    const contract = this.insertContract(terminal)
    const matchingPresentation = Boolean(
      presentation &&
        presentation.providerId === terminal.providerId &&
        hostPathEquals(presentation.workspaceRoot, terminal.workspaceRoot),
    )
    return {
      terminalId: terminal.id,
      title: matchingPresentation
        ? presentation!.title
        : `${provider.manifest.displayName} · ${terminal.id.slice(0, 8)}`,
      providerName: provider.manifest.displayName,
      lifecycle: 'live',
      connection: 'connected',
      attention: matchingPresentation ? presentation?.attention : undefined,
      capability: contract ? 'insert' : 'copy-only',
    }
  }

  private insertContract(
    terminal: ManagedPty,
  ): HarnessDocumentReviewInsertContract | undefined {
    const contract = this.options.providers.get(terminal.providerId).documentReviewInsert
    return contract &&
      terminal.capabilities.reviewInsertContractRevision === contract.revision
      ? contract
      : undefined
  }

  private revokePrepared(record: PreparedRecord | undefined): void {
    if (!record) return
    const key = ownerKey(record.owner)
    if (this.prepared.get(key) === record) this.prepared.delete(key)
    record.lease?.release()
    record.lease = undefined
  }

  private assertActive(): void {
    if (this.disposed) throw new Error('Document review delivery is disposed')
  }
}

function payloadFor(
  review: DocumentReviewDeliveryWorkspaceSnapshot,
  selection: DocumentReviewDeliverySelection,
): DocumentReviewDeliveryPayload {
  const result = prepareDocumentReviewDeliveryPayload(review.model, selection)
  if (!result.ok) throw new Error(result.error)
  return result.value
}

function terminalSnapshot(terminal: ManagedPty): PreparedRecord['terminal'] {
  return {
    id: terminal.id,
    instanceId: terminal.instanceId,
    ownerId: terminal.ownerId,
    ownerGeneration: terminal.ownerGeneration,
    hostId: terminal.hostId,
    workspaceRoot: terminal.workspaceRoot,
    providerId: terminal.providerId,
  }
}

function sameTerminal(
  current: ManagedPty,
  prepared: PreparedRecord['terminal'],
): boolean {
  return (
    current.id === prepared.id &&
    current.instanceId === prepared.instanceId &&
    current.ownerId === prepared.ownerId &&
    current.ownerGeneration === prepared.ownerGeneration &&
    current.hostId === prepared.hostId &&
    current.providerId === prepared.providerId &&
    hostPathEquals(current.workspaceRoot, prepared.workspaceRoot)
  )
}

function samePayload(
  left: DocumentReviewDeliveryPayload,
  right: DocumentReviewDeliveryPayload,
): boolean {
  return (
    left.body === right.body &&
    left.byteLength === right.byteLength &&
    left.commentIds.length === right.commentIds.length &&
    left.commentIds.every((id, index) => id === right.commentIds[index])
  )
}

function ownerKey(owner: RendererOwner): string {
  return `${owner.id}:${owner.generation}`
}

function sameOwner(left: RendererOwner, right: RendererOwner): boolean {
  return left.id === right.id && left.generation === right.generation
}
