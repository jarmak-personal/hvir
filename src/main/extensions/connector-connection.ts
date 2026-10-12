import { randomUUID } from 'node:crypto'
import { extensionRequestIdentity } from '../../shared/extensions/validation'
import type { ExtensionActivation, ExtensionActivationOwner } from './activation'
import {
  canonicalExecutablePath,
  type ExtensionConnectorApprovalOwner,
} from './connector-approval'
import type { RendererOwner, RendererResourceScopes } from '../renderer-resource-scopes'
import type {
  ExtensionConnectionResult,
  ExtensionConnectionProposal,
  ExtensionConnectorApproval,
} from '../../shared/extensions/connectors'
import {
  discoverConnectorExecutables,
  absentExecutableMetadata,
} from './connector-discovery'
import type { PinnedWorkspaceConnectionContext } from './context-owner'

export interface ExtensionConnectionDialog {
  readonly folders: readonly string[]
  choose(
    this: void,
    owner: RendererOwner,
    program: string,
    candidates: readonly string[],
  ): Promise<string | undefined>
}

interface PendingConnection {
  readonly activation: ExtensionActivation
  readonly owner: RendererOwner
  readonly controller: AbortController
  readonly signal: AbortSignal
  readonly current: () => void
  proposal?: ExtensionConnectionProposal
  settle?: (accepted: boolean) => void
  presentationReady?: () => void
}

/** Proposes native consent using existing approval tokens, outside the installation writer. */
export class ExtensionConnectorConnectionOwner {
  private readonly rendererIntents = new Map<
    string,
    { owner: RendererOwner; controller: AbortController }
  >()
  private readonly pending = new Set<PendingConnection>()
  private disposed = false
  constructor(
    private readonly scopes: RendererResourceScopes,
    private readonly windowVisible: (owner: RendererOwner) => boolean,
    private readonly activations: Pick<
      ExtensionActivationOwner,
      'active' | 'assertWritable'
    >,
    private readonly approvals: ExtensionConnectorApprovalOwner,
    private readonly dialog: ExtensionConnectionDialog,
    private readonly publish: (
      owner: RendererOwner,
      proposals: readonly ExtensionConnectionProposal[],
    ) => void,
  ) {}

  async fromRenderer(
    owner: RendererOwner,
    activation: ExtensionActivation,
    current: () => void,
    connector: string,
    request: string,
    foreground: () => boolean,
  ): Promise<ExtensionConnectionResult> {
    this.scopes.assertCurrent(owner)
    extensionRequestIdentity(request)
    if (this.rendererIntents.has(request) || this.rendererIntents.size >= 4)
      throw new Error('Invalid or busy program connection request')
    const controller = new AbortController()
    const lease = this.scopes.register(
      owner,
      { lifetime: 'renderer', type: 'extension-program-connection' },
      () => controller.abort(),
    )
    this.rendererIntents.set(request, { owner, controller })
    try {
      return await this.request(
        activation,
        owner,
        () => {
          this.scopes.assertCurrent(owner)
          current()
        },
        controller.signal,
        foreground,
        connector,
      )
    } finally {
      this.rendererIntents.delete(request)
      controller.abort()
      lease.release()
    }
  }

  cancelRenderer(owner: RendererOwner, request: string): void {
    const intent = this.rendererIntents.get(request)
    if (intent?.owner.id === owner.id && intent.owner.generation === owner.generation)
      intent.controller.abort()
  }

  async request(
    activation: ExtensionActivation,
    owner: RendererOwner,
    current: (passive: boolean) => boolean | void,
    signal: AbortSignal,
    foreground: () => boolean,
    connector?: string,
    automatic = false,
    workspace?: PinnedWorkspaceConnectionContext,
  ): Promise<ExtensionConnectionResult> {
    if (this.disposed || this.pending.size >= 4)
      throw new Error('Program connection is unavailable or already busy')
    const declarations = (activation.revision.manifest.connectors ?? []).filter(
      (entry) =>
        entry.setup &&
        (!connector || entry.id === connector) &&
        (entry.context === 'application' || (!automatic && !!connector)),
    )
    if (connector && declarations.length !== 1)
      throw new Error(
        'This program has no setup hint for this request; configure it in Settings',
      )
    const needsWorkspace = declarations.some((entry) => entry.context === 'workspace')
    const controller = new AbortController()
    const lifetime = AbortSignal.any([signal, controller.signal])
    const tokens: string[] = []
    const connections: ExtensionConnectionResult['connections'][number][] = []
    let selecting = false
    let awaitingPresentation = false
    const assertCurrent = (): void => {
      lifetime.throwIfAborted()
      if (needsWorkspace && !workspace?.current())
        throw new Error('Program connection requires a current registered local project')
      const ready = current(selecting || awaitingPresentation)
      if ((selecting || awaitingPresentation) && !this.windowVisible(owner))
        throw new Error('Program selection window is unavailable')
      if (!selecting && !foreground())
        throw new Error('Program connection requires a foreground window')
      if (
        this.disposed ||
        this.activations.active.get(activation.installationId) !== activation
      )
        throw new Error('Program connection context ended')
      if (awaitingPresentation && ready !== false) pending.presentationReady?.()
    }
    const pending: PendingConnection = {
      activation,
      owner,
      controller,
      signal: lifetime,
      current: assertCurrent,
    }
    this.pending.add(pending)
    const deadline = setTimeout(
      () => controller.abort(new Error('Program connection decision expired')),
      60_000,
    )
    let submitted: string | undefined
    let disposeWorkspace: (() => void) | undefined
    try {
      if (needsWorkspace) {
        assertCurrent()
        disposeWorkspace = workspace!.observeCurrent(() => controller.abort())
        assertCurrent()
      }
      await connectionWait(this.activations.assertWritable(), lifetime)
      assertCurrent()
      const host = this.approvals.hosts.hostById(this.approvals.hosts.local.hostId)
      if (!host) throw new Error('Local program metadata is unavailable')
      const prepared: {
        token: string
        approval: ExtensionConnectorApproval
        replacesHost?: string
      }[] = []
      for (const declaration of declarations) {
        assertCurrent()
        const existing = this.approvals.get(activation, declaration.id)
        let complete = true
        if (
          existing?.host === host.hostId &&
          this.approvals.current(activation, existing)
        ) {
          try {
            if (
              (await connectionWait(
                canonicalExecutablePath(host, existing.executable),
                lifetime,
              )) === existing.canonicalExecutable
            ) {
              assertCurrent()
              connections.push({ connector: declaration.id, outcome: 'connected' })
              continue
            }
          } catch (reason) {
            assertCurrent()
            if (!absentExecutableMetadata(reason)) complete = false
          }
        }
        const discovered = await connectionWait(
          discoverConnectorExecutables(
            host,
            declaration.setup!.executable,
            this.dialog.folders,
            assertCurrent,
          ),
          lifetime,
        )
        assertCurrent()
        const candidates = discovered.candidates
        complete &&= discovered.complete
        if (automatic && (!complete || candidates.length === 0)) {
          connections.push({
            connector: declaration.id,
            outcome: 'unavailable',
            explanation: complete
              ? `${declaration.setup!.executable} was not found. Install it, then choose Connect. The extension is already installed.`
              : 'Some program locations could not be checked. The extension is installed; choose Connect to select the installed program.',
          })
          continue
        }
        let executable = complete && candidates.length === 1 ? candidates[0] : undefined
        if (!complete || candidates.length !== 1) {
          // Passive native selection can make its own parent non-key. Nothing is
          // prepared or approved until it returns to fresh foreground authority.
          assertCurrent()
          selecting = true
          try {
            executable = await connectionWait(
              this.dialog.choose(owner, declaration.setup!.executable, candidates),
              lifetime,
            )
          } finally {
            selecting = false
          }
          // A native return can precede the foreground visibility publication.
          // Retain only this selected intent; preparation still awaits actual visibility.
          awaitingPresentation = true
          try {
            assertCurrent()
            await connectionWait(
              new Promise<void>((resolve) => {
                pending.presentationReady = resolve
                assertCurrent()
              }),
              lifetime,
            )
          } finally {
            pending.presentationReady = undefined
            awaitingPresentation = false
          }
        }
        assertCurrent()
        await connectionWait(this.activations.assertWritable(), lifetime)
        assertCurrent()
        if (!executable) {
          connections.push({
            connector: declaration.id,
            outcome: 'unavailable',
            explanation:
              'No installed program was selected. The extension is installed; connect a program when ready.',
          })
          continue
        }
        const preparation = this.approvals.prepare(
          {
            installationId: activation.installationId,
            connector: declaration.id,
            host: host.hostId,
            executable,
            configuration: { args: [], env: {} },
          },
          assertCurrent,
          { approval: existing },
        )
        // Late completion has no authority to retain a prepared decision after cancellation.
        void preparation.then(
          (value) => {
            if (lifetime.aborted) this.approvals.cancelPrepared(value.token)
          },
          () => undefined,
        )
        const decision = await connectionWait(preparation, lifetime)
        tokens.push(decision.token)
        this.approvals
          .preparedSignal(decision.token)
          .addEventListener('abort', () => controller.abort(), {
            once: true,
            signal: lifetime,
          })
        prepared.push({
          ...decision,
          ...(existing && existing.host !== host.hostId
            ? { replacesHost: existing.host }
            : {}),
        })
      }
      assertCurrent()
      if (
        prepared.length &&
        !(await this.confirm(
          pending,
          prepared.map((entry) => ({
            ...entry.approval,
            ...(entry.replacesHost ? { replacesHost: entry.replacesHost } : {}),
          })),
        ))
      ) {
        assertCurrent()
        for (const entry of prepared)
          connections.push({ connector: entry.approval.connector, outcome: 'declined' })
        return { connections }
      }
      for (const decision of prepared) {
        assertCurrent()
        await connectionWait(this.activations.assertWritable(), lifetime)
        assertCurrent()
        submitted = decision.approval.connector
        // Await the actual consent write: interruption after submission may have committed.
        await this.approvals.approve(decision.token)
        connections.push({ connector: submitted, outcome: 'connected' })
        submitted = undefined
      }
      return { connections }
    } catch {
      for (const declaration of declarations)
        if (!connections.some((entry) => entry.connector === declaration.id))
          connections.push({
            connector: declaration.id,
            outcome:
              submitted === declaration.id ? 'interrupted-uncertain' : 'unavailable',
            explanation:
              submitted === declaration.id
                ? 'Connection was interrupted after saving began. Check the current program access before trying again.'
                : 'Connection ended before approval. The extension remains installed.',
          })
      return { connections }
    } finally {
      disposeWorkspace?.()
      clearTimeout(deadline)
      for (const token of tokens) this.approvals.cancelPrepared(token)
      controller.abort()
      this.pending.delete(pending)
    }
  }

  snapshot(owner: RendererOwner): readonly ExtensionConnectionProposal[] {
    return [...this.pending]
      .filter(
        (entry) =>
          entry.owner.id === owner.id && entry.owner.generation === owner.generation,
      )
      .flatMap((entry) => (entry.proposal ? [entry.proposal] : []))
  }

  decide(owner: RendererOwner, id: string, accepted: boolean): void {
    const pending = [...this.pending].find(
      (entry) =>
        entry.proposal?.id === id &&
        entry.owner.id === owner.id &&
        entry.owner.generation === owner.generation,
    )
    if (!pending || typeof accepted !== 'boolean')
      throw new Error('Program connection proposal ended')
    pending.current()
    pending.settle?.(accepted)
  }

  private confirm(
    pending: PendingConnection,
    approvals: readonly (ExtensionConnectorApproval & {
      readonly replacesHost?: string
    })[],
  ): Promise<boolean> {
    pending.current()
    return new Promise((resolve, reject) => {
      const abort = (): void => finish(false)
      const finish = (accepted: boolean, failure?: unknown): void => {
        if (!pending.proposal) return
        pending.proposal = undefined
        pending.settle = undefined
        pending.signal.removeEventListener('abort', abort)
        try {
          this.publish(pending.owner, this.snapshot(pending.owner))
        } catch (reason) {
          failure ??= reason
        }
        if (failure)
          reject(
            failure instanceof Error
              ? failure
              : new Error('Connection publication failed', { cause: failure }),
          )
        else resolve(accepted)
      }
      pending.proposal = {
        id: randomUUID(),
        installationId: pending.activation.installationId,
        name: pending.activation.revision.manifest.name,
        programs: approvals.map((entry) => ({
          connector: entry.connector,
          description: entry.declaration.description,
          context: entry.declaration.context,
          ...(entry.replacesHost ? { replacesHost: entry.replacesHost } : {}),
          host: entry.host,
          canonicalExecutable: entry.canonicalExecutable,
          configuration: entry.configuration,
        })),
      }
      pending.settle = finish
      pending.signal.addEventListener('abort', abort, { once: true })
      if (pending.signal.aborted) abort()
      else {
        try {
          this.publish(pending.owner, this.snapshot(pending.owner))
        } catch (reason) {
          finish(false, reason)
        }
      }
    })
  }

  revalidate(): void {
    for (const entry of this.pending) {
      try {
        entry.current()
      } catch {
        entry.controller.abort()
      }
    }
  }

  revoke(installation: string): void {
    for (const entry of this.pending)
      if (entry.activation.installationId === installation) entry.controller.abort()
  }
  dispose(): void {
    this.disposed = true
    for (const entry of this.pending) entry.controller.abort()
  }
}

/** Native file pickers have no close port; late replies remain inert after cancellation. */
async function connectionWait<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  let abort!: () => void
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_, reject) => {
        abort = () =>
          reject(
            signal.reason instanceof Error
              ? signal.reason
              : new Error('Program connection ended'),
          )
        signal.addEventListener('abort', abort, { once: true })
        if (signal.aborted) abort()
      }),
    ])
  } finally {
    signal.removeEventListener('abort', abort)
  }
}
