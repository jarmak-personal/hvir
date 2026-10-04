import { randomUUID } from 'node:crypto'
import { hostPathEquals, type HostPath } from '../../shared/host-path'
import type { RendererOwner } from '../renderer-resource-scopes'
import type { PlainShellCommandOnce } from '../harness/harness-provider-contract'

import type { TerminalCommandRequest } from '../../shared/ipc/terminal'
export type { TerminalCommandRequest } from '../../shared/ipc/terminal'
export type TerminalCommandOutcome =
  | { readonly outcome: 'handed-off'; readonly terminalId: string }
  | { readonly outcome: 'not-started' | 'interrupted-uncertain'; readonly reason: string }
interface Admission {
  readonly request: TerminalCommandRequest
  readonly owner: RendererOwner
  readonly command: PlainShellCommandOnce
  readonly current: () => void
  readonly revalidate: () => Promise<void>
  readonly signal: AbortSignal
  readonly finish: (outcome: TerminalCommandOutcome, settled?: boolean) => void
  readonly cleanup: () => void
  readonly revoke: () => void
  consumed: boolean
  dispatched: boolean
  published: boolean
  settled: boolean
}

/** One-use admission ends at ordinary terminal ownership, never owns a live session. */
export class TerminalCommandHandoffOwner {
  private readonly pending = new Map<string, Admission>()
  private disposed = false
  constructor(
    private readonly publish: (
      owner: RendererOwner,
      request: TerminalCommandRequest,
    ) => void,
    private readonly revoked?: (owner: RendererOwner, ticket: string) => void,
  ) {}

  request(input: {
    readonly owner: RendererOwner
    readonly workspaceId: string
    readonly root: HostPath
    readonly command: PlainShellCommandOnce
    readonly current: () => void
    readonly revalidate?: () => Promise<void>
    readonly prepare?: (signal: AbortSignal) => Promise<boolean>
    readonly decisionTimeoutMs?: number
    readonly signal: AbortSignal
  }): Promise<TerminalCommandOutcome> {
    input.current()
    input.signal.throwIfAborted()
    if (
      input.decisionTimeoutMs !== undefined &&
      (!Number.isSafeInteger(input.decisionTimeoutMs) || input.decisionTimeoutMs < 1)
    )
      throw new Error('Invalid terminal decision deadline')
    if (this.disposed || this.pending.size >= 4)
      throw new Error('Terminal handoff admission is unavailable')
    const request = {
      ticket: randomUUID(),
      terminalId: randomUUID(),
      workspaceId: input.workspaceId,
      root: Object.freeze({ ...input.root }),
    }
    return new Promise((resolve) => {
      const controller = new AbortController()
      const signal = AbortSignal.any([input.signal, controller.signal])
      const end = () => {
        const admission = this.pending.get(request.ticket)
        if (!admission) return
        admission.finish({
          outcome: admission.dispatched ? 'interrupted-uncertain' : 'not-started',
          reason:
            controller.signal.reason instanceof Error
              ? controller.signal.reason.message
              : 'Terminal handoff was revoked',
        })
      }
      const expire = (decision: boolean) =>
        controller.abort(
          new Error(
            decision
              ? 'Terminal launch decision expired; run this action again'
              : 'Terminal admission expired; run this action again',
          ),
        )
      let timer = setTimeout(
        () => expire(Boolean(input.prepare)),
        input.prepare ? (input.decisionTimeoutMs ?? 10_000) : 10_000,
      )
      const admission: Admission = {
        request,
        owner: Object.freeze({ ...input.owner }),
        command: Object.freeze({
          executable: input.command.executable,
          args: Object.freeze([...input.command.args]),
          environment: Object.freeze({ ...input.command.environment }),
        }),
        signal,
        revalidate: input.revalidate ?? (() => Promise.resolve()),
        revoke: () => controller.abort(),
        consumed: false,
        dispatched: false,
        published: false,
        settled: false,
        current: () => {
          if (admission.settled) throw new Error('Terminal admission already settled')
          input.current()
          signal.throwIfAborted()
        },
        cleanup: () => {
          clearTimeout(timer)
          signal.removeEventListener('abort', end)
        },
        finish: (outcome, settled = false) => {
          if (admission.settled) return
          // Caller outcome and physical settlement have independent lifetimes.
          resolve(outcome)
          const notify = outcome.outcome !== 'handed-off' && admission.published
          if (notify) admission.published = false
          if (settled || !admission.consumed) {
            admission.settled = true
            if (this.pending.get(request.ticket) === admission)
              this.pending.delete(request.ticket)
            admission.cleanup()
          }
          // Delivery errors remain observable, but cannot retain settled authority.
          if (notify) this.revoked?.(admission.owner, request.ticket)
        },
      }
      this.pending.set(request.ticket, admission)
      signal.addEventListener('abort', end, { once: true })
      const publish = (accepted: boolean) => {
        try {
          admission.current()
          if (accepted) {
            clearTimeout(timer)
            timer = setTimeout(() => expire(false), 10_000)
            admission.published = true
            this.publish(input.owner, request)
          } else
            admission.finish({
              outcome: 'not-started',
              reason: 'Terminal launch was declined',
            })
        } catch {
          controller.abort()
          end()
        }
      }
      if (input.prepare) {
        void input.prepare(signal).then(publish, () => {
          controller.abort()
          end()
        })
      } else publish(true)
    })
  }

  consume(
    ticket: string,
    identity: {
      readonly owner: RendererOwner
      readonly terminalId: string
      readonly workspaceId: string
      readonly root: HostPath
    },
  ): {
    readonly command: PlainShellCommandOnce
    readonly signal: AbortSignal
    current(this: void): void
    prepareDispatch(this: void): Promise<void>
    dispatched(this: void): void
    finish(this: void, handedOff: boolean): void
  } {
    const admission = this.pending.get(ticket)
    if (
      !admission ||
      admission.consumed ||
      admission.owner.id !== identity.owner.id ||
      admission.owner.generation !== identity.owner.generation ||
      admission.request.terminalId !== identity.terminalId ||
      admission.request.workspaceId !== identity.workspaceId ||
      !hostPathEquals(admission.request.root, identity.root)
    )
      throw new Error('Terminal handoff is stale or names another terminal or workspace')
    admission.current()
    admission.consumed = true
    return {
      command: admission.command,
      signal: admission.signal,
      current: admission.current,
      prepareDispatch: async () => {
        admission.current()
        await admission.revalidate()
        admission.current()
      },
      dispatched: () => {
        admission.current()
        admission.dispatched = true
      },
      finish: (handedOff) =>
        admission.finish(
          handedOff && !admission.signal.aborted
            ? { outcome: 'handed-off', terminalId: identity.terminalId }
            : {
                outcome: admission.dispatched ? 'interrupted-uncertain' : 'not-started',
                reason: 'Terminal handoff did not complete',
              },
          true,
        ),
    }
  }
  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    for (const admission of this.pending.values()) admission.revoke()
  }
}
