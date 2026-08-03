import { AsyncLocalStorage } from 'node:async_hooks'

import type { SshPromptRequest } from '../../shared'
import type { RendererOwner } from '../renderer-resource-scopes'
import type { SshAuthPrompter, SshPrompt } from './ssh-auth'

interface PendingPrompt {
  readonly hostId: string
  readonly request: SshPrompt
  owner: RendererOwner
  presented: boolean
  readonly settle: (answers: readonly string[] | undefined) => void
}

/** Renderer presentation adapter; SSH policy and cancellation remain host-owned. */
export class RendererSshPrompter implements SshAuthPrompter {
  private nextId = 0
  private readonly ownerContext = new AsyncLocalStorage<RendererOwner>()
  private readonly activeOwners = new Map<number, RendererOwner>()
  private readonly pending = new Map<number, PendingPrompt>()

  constructor(
    private readonly emit: (owner: RendererOwner, prompt: SshPromptRequest) => void,
    private readonly emitCancel: (owner: RendererOwner, hostId: string) => void = () =>
      undefined,
  ) {}

  runForOwner<T>(owner: RendererOwner, operation: () => T): T {
    return this.ownerContext.run(owner, operation)
  }

  activateOwner(owner: RendererOwner): void {
    this.activeOwners.set(owner.id, owner)
    for (const [id, pending] of this.pending) {
      if (pending.owner.id !== owner.id || pending.presented) continue
      pending.owner = owner
      pending.presented = true
      this.emit(owner, { id, ...pending.request })
    }
  }

  revokeOwner(owner: RendererOwner): void {
    const active = this.activeOwners.get(owner.id)
    if (active?.generation === owner.generation) this.activeOwners.delete(owner.id)
    for (const pending of this.pending.values()) {
      if (!sameRendererOwner(pending.owner, owner)) continue
      pending.presented = false
    }
  }

  prompt(
    request: SshPrompt,
    signal: AbortSignal,
  ): Promise<readonly string[] | undefined> {
    if (signal.aborted) return Promise.resolve(undefined)
    const contextualOwner = this.ownerContext.getStore()
    const activeOwner = contextualOwner
      ? this.activeOwners.get(contextualOwner.id)
      : this.activeOwners.values().next().value
    const owner = activeOwner ?? contextualOwner
    if (!owner) return Promise.resolve(undefined)
    const id = ++this.nextId
    return new Promise((resolve) => {
      const pending: PendingPrompt = {
        hostId: request.hostId,
        request,
        owner,
        presented: activeOwner !== undefined,
        settle: (answers) => {
          if (this.pending.get(id) !== pending) return
          this.pending.delete(id)
          signal.removeEventListener('abort', abort)
          resolve(answers)
        },
      }
      const abort = (): void => {
        if (this.pending.get(id) !== pending) return
        const presented = pending.presented
        const presentationOwner = pending.owner
        pending.settle(undefined)
        if (presented) this.emitCancel(presentationOwner, pending.hostId)
      }
      this.pending.set(id, pending)
      signal.addEventListener('abort', abort, { once: true })
      if (signal.aborted) abort()
      else if (pending.presented) this.emit(owner, { id, ...request })
    })
  }

  respond(owner: RendererOwner, id: number, answers?: readonly string[]): void {
    const pending = this.pending.get(id)
    const activeOwner = this.activeOwners.get(owner.id)
    if (
      !pending ||
      !pending.presented ||
      !sameRendererOwner(pending.owner, owner) ||
      !activeOwner ||
      !sameRendererOwner(activeOwner, owner)
    ) {
      return
    }
    pending.settle(answers)
  }

  cancelAll(): void {
    const presentations = new Map<
      string,
      { readonly hostId: string; readonly owner: RendererOwner }
    >()
    for (const pending of this.pending.values()) {
      if (pending.presented) {
        presentations.set(
          `${pending.hostId}:${pending.owner.id}:${pending.owner.generation}`,
          { hostId: pending.hostId, owner: pending.owner },
        )
      }
    }
    for (const pending of [...this.pending.values()]) pending.settle(undefined)
    for (const { hostId, owner } of presentations.values()) {
      this.emitCancel(owner, hostId)
    }
  }
}

function sameRendererOwner(left: RendererOwner, right: RendererOwner): boolean {
  return left.id === right.id && left.generation === right.generation
}
