import { randomUUID } from 'node:crypto'
import { validateActionInput } from '../../shared/extensions/action-input'
import {
  EXTENSION_LIMITS,
  type ExtensionInvocation,
} from '../../shared/extensions/contract'
import type {
  ExtensionSurfaceRequest,
  ExtensionView,
} from '../../shared/extensions/workbench'
import type { RendererOwner } from '../renderer-resource-scopes'
import type { ExtensionActivation } from './activation'
import type { ExtensionViewAuthority } from './guest-authority'

export interface ExtensionActionGuestPort {
  open(
    this: void,
    owner: RendererOwner,
    installation: string,
    contribution: string,
    options: {
      context: ExtensionSurfaceRequest
      focus: boolean
      authority?: ExtensionViewAuthority
    },
    admit: () => void,
  ): Promise<ExtensionView>
  dispatch(this: void, viewId: string, invocation: ExtensionInvocation): boolean
  runnable(this: void, viewId: string, action: string, admitted: boolean): void
  cancelAction(this: void, viewId: string, id: string): void
  assertView(this: void, viewId: string): void
}
interface PendingAction {
  readonly authority?: ExtensionActionAuthority
  readonly activation: ExtensionActivation
  viewId?: string
  invocation?: ExtensionInvocation
  delivered: boolean
  readonly current: () => void
  readonly resolve: (value: unknown) => void
  readonly reject: (reason: unknown) => void
  readonly timer: ReturnType<typeof setTimeout>
}
/** Main-only execution authority, deliberately absent from guest invocation data. */
export interface ExtensionActionAuthority {
  readonly authorizeAction?: (
    binding: {
      readonly title: string
      readonly input: string
      readonly effects: { readonly delete: boolean; readonly replace: boolean }
    },
    current: () => void,
    signal: AbortSignal,
  ) => Promise<'standing' | 'interactive'>
  readonly view?: ExtensionViewAuthority
  readonly forAction?: (action: string) => ExtensionActionAuthority
  assertCapability(capability: string, host: string, workspace?: string): void
}

/** Finite invocation provenance and lifetime; declarations never confer host capabilities. */
export class ExtensionActionOwner {
  changed?: () => void
  private revalidationScheduled = false
  private readonly pending = new Map<string, PendingAction>()
  constructor(private readonly guests: ExtensionActionGuestPort) {}

  invoke(
    owner: RendererOwner,
    activation: ExtensionActivation,
    actionId: string,
    input: unknown,
    context: ExtensionSurfaceRequest,
    caller: ExtensionInvocation['caller'],
    authorization: ExtensionInvocation['authorization'],
    current: () => void,
    signal?: AbortSignal,
    authority?: ExtensionActionAuthority,
  ): Promise<unknown> {
    current()
    signal?.throwIfAborted()
    const action = activation.revision.manifest.actions?.find(
      (entry) => entry.id === actionId,
    )
    if (!action || (caller === 'agent' && !action.agents))
      throw new Error('Action is unavailable to this caller')
    boundedValue(input)
    if (action.inputSchema) validateActionInput(input, action.inputSchema)
    if (
      this.pending.size >= EXTENSION_LIMITS.actionsPending ||
      [...this.pending.values()].filter((entry) => entry.activation === activation)
        .length >= EXTENSION_LIMITS.actionsPerExtension
    )
      throw new Error('Extension action capacity is full')
    const id = randomUUID()
    const cancelled = (): void =>
      this.end(id, new Error('Extension action was cancelled'))
    const result = new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => this.end(id, new Error('Extension action timed out')),
        action.timeoutMs ?? EXTENSION_LIMITS.actionTimeoutMs,
      )
      const assert = (): void => {
        if (!this.pending.has(id)) throw new Error('Extension action was cancelled')
        signal?.throwIfAborted()
        current()
      }
      const pending: PendingAction = {
        ...(authority ? { authority } : {}),
        activation,
        delivered: false,
        current: assert,
        resolve,
        reject,
        timer,
      }
      this.pending.set(id, pending)
      signal?.addEventListener('abort', cancelled, { once: true })
      void this.guests
        .open(
          owner,
          activation.installationId,
          action.view,
          { context, focus: false, authority: authority?.view },
          assert,
        )
        .then((view) => {
          assert()
          this.guests.assertView(view.id)
          pending.viewId = view.id
          pending.invocation = {
            id,
            action: actionId,
            input,
            context: view.context!,
            caller,
            authorization,
          }
          this.guests.runnable(view.id, id, true)
          this.deliver(pending)
        })
        .catch((reason: unknown) => this.end(id, reason))
    })
    return result.finally(() => signal?.removeEventListener('abort', cancelled))
  }

  provenance(viewId: string, id: unknown): ExtensionInvocation | undefined {
    if (typeof id !== 'string') return undefined
    const pending = this.pending.get(id)
    if (!pending || pending.viewId !== viewId) return undefined
    try {
      pending.current()
      this.guests.assertView(viewId)
    } catch (reason) {
      this.end(id, reason)
      return undefined
    }
    return pending.invocation
  }
  authority(viewId: string, id: string): ExtensionActionAuthority | undefined {
    if (!this.provenance(viewId, id)) throw new Error('Originating action was revoked')
    return this.pending.get(id)?.authority
  }
  result(viewId: string, id: string, value: unknown, error?: string): void {
    const pending = this.pending.get(id)
    if (!pending || !this.provenance(viewId, id))
      throw new Error('Action invocation is stale or forged')
    boundedValue(value)
    if (error !== undefined && (typeof error !== 'string' || error.length > 240))
      throw new Error('Invalid action error')
    this.pending.delete(id)
    clearTimeout(pending.timer)
    this.scheduleRevalidation()
    this.guests.runnable(viewId, id, false)
    if (error) pending.reject(new Error(error))
    else pending.resolve(value)
  }
  ready(viewId: string): void {
    for (const pending of this.pending.values())
      if (pending.viewId === viewId) this.deliver(pending)
  }
  revalidate(): void {
    for (const [id, pending] of this.pending) {
      try {
        pending.current()
      } catch (reason) {
        this.end(id, reason)
      }
    }
  }
  revokeInstallation(activation: ExtensionActivation | string): void {
    for (const [id, pending] of this.pending)
      if (
        typeof activation === 'string'
          ? pending.activation.installationId === activation
          : pending.activation === activation
      )
        this.end(id, new Error('Extension activation was revoked'))
  }
  revokeView(viewId: string): void {
    for (const [id, pending] of this.pending)
      if (pending.viewId === viewId)
        this.end(id, new Error('Extension action context was revoked'))
  }
  private scheduleRevalidation(): void {
    if (this.revalidationScheduled) return
    this.revalidationScheduled = true
    queueMicrotask(() => {
      this.revalidationScheduled = false
      this.revalidate()
      this.changed?.()
    })
  }
  private deliver(pending: PendingAction): void {
    if (!pending.delivered && pending.viewId && pending.invocation) {
      try {
        pending.current()
        pending.delivered = this.guests.dispatch(pending.viewId, pending.invocation)
      } catch (reason) {
        this.end(pending.invocation.id, reason)
      }
    }
  }
  private end(id: string, reason: unknown): void {
    const pending = this.pending.get(id)
    if (!pending) return
    this.pending.delete(id)
    clearTimeout(pending.timer)
    this.scheduleRevalidation()
    if (pending.viewId) {
      this.guests.cancelAction(pending.viewId, id)
      this.guests.runnable(pending.viewId, id, false)
    }
    pending.reject(reason)
  }
}
function boundedValue(value: unknown): void {
  if (Buffer.byteLength(JSON.stringify(value ?? null)) > EXTENSION_LIMITS.actionBytes)
    throw new Error('Action value exceeds its byte limit')
}
