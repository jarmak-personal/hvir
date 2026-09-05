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
  type DocumentReviewSendNowResult,
  type PreparedDocumentReviewDelivery,
} from '../../shared'
import type {
  HarnessDocumentReviewInsertContract,
  HarnessDocumentReviewSendNowContract,
  HarnessDocumentReviewSendNowLaunch,
} from '../harness/harness-provider-contract'
import type { HarnessProviderRegistry } from '../harness/harness-provider-registry'
import type { HarnessProfileStoreContract } from '../harness/harness-profile-store'
import { isPtyWriteIndeterminateError } from '../project-host'
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
import {
  matchesPreparedDocumentReviewTerminal,
  snapshotDocumentReviewTerminal,
  type PreparedDocumentReviewTerminal,
} from './document-review-delivery-terminal'

interface PreparedRecord {
  readonly id: string
  readonly owner: RendererOwner
  readonly scope: DocumentReviewDeliveryScopeRequest
  readonly selection: DocumentReviewDeliverySelection
  readonly reviewRevision: number
  readonly payload: DocumentReviewDeliveryPayload
  readonly destination: DocumentReviewDeliveryDestination
  readonly contractRevision: number
  readonly sendNowContractRevision?: number
  readonly terminal: PreparedDocumentReviewTerminal
  lease?: RendererResourceLease
  inFlight?: symbol
  revoked?: boolean
}

export interface DocumentReviewDeliveryCoordinatorOptions {
  readonly workspace: Pick<
    DocumentReviewCoordinator,
    'deliverySnapshot' | 'completeDelivery'
  >
  readonly ptys: Pick<PtySupervisor, 'get' | 'list' | 'write' | 'writeConfirmed'>
  readonly sessions: Pick<TerminalSessionStore, 'get'>
  readonly providers: Pick<HarnessProviderRegistry, 'get'>
  readonly profiles: Pick<HarnessProfileStoreContract, 'get'>
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
      .map((terminal) => ({
        terminal,
        presentation: this.trustedPresentation(terminal),
      }))
      .toSorted(
        (left, right) =>
          (left.presentation?.position ?? Number.MAX_SAFE_INTEGER) -
            (right.presentation?.position ?? Number.MAX_SAFE_INTEGER) ||
          left.terminal.startedAt - right.terminal.startedAt ||
          left.terminal.id.localeCompare(right.terminal.id),
      )
      .map(({ terminal, presentation }) => this.describe(terminal, presentation))
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
    const destination = this.describe(terminal, this.trustedPresentation(terminal))
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
      sendNowContractRevision: this.sendNowContract(terminal)?.contract.revision,
      terminal: snapshotDocumentReviewTerminal(terminal),
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
    const prepared = this.requirePrepared(owner, preparedId)
    if (prepared.inFlight) throw new Error('Review delivery is already in progress')
    const { payload, terminal } = this.validatePrepared(owner, prepared)
    const provider = this.options.providers.get(terminal.providerId)
    const contract = provider.documentReviewInsert
    if (
      !contract ||
      contract.revision !== prepared.contractRevision ||
      terminal.capabilities.reviewInsertContractRevision !== contract.revision ||
      prepared.destination.capability === 'copy-only'
    ) {
      throw new Error('The prepared provider insertion capability changed')
    }
    const transport = contract.terminalInput(payload.body)
    this.options.ptys.write(terminal.id, owner.id, transport, owner.generation)
    this.revokePrepared(prepared)
    return { outcome: 'inserted' }
  }

  async sendNow(
    owner: RendererOwner,
    preparedId: string,
  ): Promise<DocumentReviewSendNowResult> {
    const prepared = this.requirePrepared(owner, preparedId)
    if (
      prepared.destination.capability !== 'send-now' ||
      prepared.sendNowContractRevision === undefined
    ) {
      throw new Error('The prepared destination remains Insert-only')
    }
    if (prepared.inFlight) throw new Error('Review delivery is already in progress')
    const attempt = Symbol(prepared.id)
    prepared.inFlight = attempt
    try {
      const before = this.validatePrepared(owner, prepared)
      const sendNow = this.sendNowContract(before.terminal)
      if (!sendNow || sendNow.contract.revision !== prepared.sendNowContractRevision) {
        throw new Error('The prepared provider submission capability changed')
      }
      const transport = sendNow.contract.terminalInput(
        before.payload.body,
        sendNow.launch,
      )
      try {
        await this.options.ptys.writeConfirmed(
          before.terminal.id,
          owner.id,
          transport,
          owner.generation,
        )
      } catch (reason) {
        if (!isPtyWriteIndeterminateError(reason)) throw reason
        this.consumePrepared(prepared)
        return {
          outcome: 'send-authority-consumed',
          ptyAcceptance: 'indeterminate',
          reason: errorMessage(reason),
        }
      }

      // Once the transport confirms acceptance, the exact send authority is
      // consumed even if later validation or durable lifecycle persistence fails.
      this.consumePrepared(prepared)

      // A completed transport may race exit, disconnect, renderer/workspace
      // revocation, profile edits, or provider replacement. None can turn a late
      // completion into lifecycle authority.
      try {
        const after = this.validatePrepared(owner, prepared, false)
        const currentSendNow = this.sendNowContract(after.terminal)
        if (
          !currentSendNow ||
          currentSendNow.contract.revision !== prepared.sendNowContractRevision ||
          currentSendNow.contract.terminalInput(
            after.payload.body,
            currentSendNow.launch,
          ) !== transport
        ) {
          throw new Error('The prepared provider submission capability changed')
        }
        const snapshot = await this.options.workspace.completeDelivery(owner, {
          ...prepared.scope,
          expectedRevision: after.review.revision,
          commentIds: after.payload.commentIds,
        })
        return { outcome: 'sent', snapshot }
      } catch (reason) {
        return {
          outcome: 'send-authority-consumed',
          ptyAcceptance: 'confirmed',
          reason: errorMessage(reason),
        }
      }
    } finally {
      if (prepared.inFlight === attempt) prepared.inFlight = undefined
    }
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
    const insert = this.insertContract(terminal)
    const sendNow = this.sendNowContract(terminal)
    return {
      terminalId: terminal.id,
      title: presentation
        ? presentation.title
        : `${provider.manifest.displayName} · ${terminal.id.slice(0, 8)}`,
      providerName: provider.manifest.displayName,
      lifecycle: 'live',
      connection: 'connected',
      attention: presentation?.attention,
      capability: sendNow ? 'send-now' : insert ? 'insert' : 'copy-only',
    }
  }

  private trustedPresentation(terminal: ManagedPty): OwnedTerminalSession | undefined {
    const presentation = this.options.sessions.get(terminal.id)
    return presentation &&
      presentation.providerId === terminal.providerId &&
      hostPathEquals(presentation.workspaceRoot, terminal.workspaceRoot)
      ? presentation
      : undefined
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

  private sendNowContract(terminal: ManagedPty):
    | {
        readonly contract: HarnessDocumentReviewSendNowContract
        readonly launch: HarnessDocumentReviewSendNowLaunch
      }
    | undefined {
    const provider = this.options.providers.get(terminal.providerId)
    const contract = provider.documentReviewSendNow
    if (
      !contract ||
      terminal.capabilities.reviewSendNowContractRevision !== contract.revision ||
      !terminal.profileId ||
      terminal.launchRevision === undefined ||
      terminal.providerContractVersion === undefined ||
      terminal.composerSubmitMode === undefined
    ) {
      return undefined
    }
    const profile = this.options.profiles.get(terminal.profileId)
    if (
      !profile ||
      profile.providerId !== terminal.providerId ||
      profile.launchRevision !== terminal.launchRevision ||
      profile.providerContractVersion !== terminal.providerContractVersion
    ) {
      return undefined
    }
    const launch = {
      profile,
      composerSubmitMode: terminal.composerSubmitMode,
      effectiveCapabilities: terminal.capabilities,
    } satisfies HarnessDocumentReviewSendNowLaunch
    return contract.supportsLaunch(launch) ? { contract, launch } : undefined
  }

  private requirePrepared(owner: RendererOwner, preparedId: string): PreparedRecord {
    this.assertActive()
    const prepared = this.prepared.get(ownerKey(owner))
    if (!prepared || prepared.id !== preparedId || !sameOwner(prepared.owner, owner)) {
      throw new Error('The prepared review destination is stale')
    }
    return prepared
  }

  private validatePrepared(
    owner: RendererOwner,
    prepared: PreparedRecord,
    requireAuthority = true,
  ): {
    readonly review: DocumentReviewDeliveryWorkspaceSnapshot
    readonly payload: DocumentReviewDeliveryPayload
    readonly terminal: ManagedPty
  } {
    if (
      prepared.revoked ||
      (requireAuthority && this.requirePrepared(owner, prepared.id) !== prepared)
    ) {
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
    if (
      !terminal ||
      !matchesPreparedDocumentReviewTerminal(terminal, prepared.terminal)
    ) {
      throw new Error('The prepared review terminal is no longer live')
    }
    return { review, payload, terminal }
  }

  private revokePrepared(record: PreparedRecord | undefined): void {
    if (!record) return
    record.revoked = true
    this.consumePrepared(record)
  }

  private consumePrepared(record: PreparedRecord): void {
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

function errorMessage(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason)
}
