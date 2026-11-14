import { writeTerminalClipboard } from './terminal-clipboard-write'
import { decodeClipboardOsc } from '../../shared/terminal-clipboard-osc'
import type { NativeTerminalSession } from '../../shared/native-terminal'
import type {
  NativeTerminalEffect,
  NativeTerminalEffectBatch,
  NativeTerminalProductEffect,
} from '../../shared/native-terminal-effects'

export interface NativeTerminalEffectObservation {
  readonly session: NativeTerminalSession
  readonly batch: NativeTerminalEffectBatch
  readonly executionFailures: number
}
export interface NativeTerminalEffectAuthority {
  /** Retained metadata belongs to this exact current instance and renderer. */
  current(): boolean
  /** Transient effects additionally require a physically writable live PTY. */
  live(): boolean
}
/** Executes copied facts through current main-owned authority, never native callbacks. */
export class NativeTerminalEffectPolicy {
  private readonly listeners = new Set<
    (observation: NativeTerminalEffectObservation) => void
  >()
  constructor(
    private readonly clipboard: { writeText(text: string): void },
    private readonly publish: (
      session: NativeTerminalSession,
      effect: NativeTerminalProductEffect,
    ) => void,
  ) {}
  observe(listener: (observation: NativeTerminalEffectObservation) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }
  consume(
    session: NativeTerminalSession,
    batch: NativeTerminalEffectBatch,
    authority: NativeTerminalEffectAuthority,
  ): void {
    let executionFailures = 0
    for (const effect of batch.effects) {
      if (!authority.current()) break
      try {
        this.execute(session, effect, authority)
      } catch {
        executionFailures++
      }
    }
    // Main-only observations carry facts, not deferred execution capabilities.
    for (const listener of this.listeners) {
      try {
        listener({ session, batch, executionFailures })
      } catch {
        /* An observer grants no producer authority. */
      }
    }
  }
  private execute(
    session: NativeTerminalSession,
    effect: NativeTerminalEffect,
    authority: NativeTerminalEffectAuthority,
  ): void {
    if (effect.kind === 'clipboard') {
      if (!authority.live()) return
      const decision = decodeClipboardOsc(effect)
      if (decision.kind !== 'write' || !authority.current() || !authority.live()) return
      writeTerminalClipboard(this.clipboard, decision.text)
    } else if (effect.kind === 'title') {
      this.publish(session, {
        id: session.sessionId,
        instanceId: session.instanceId,
        eventSerial: effect.eventSerial,
        effect: { kind: 'title', title: effect.title },
      })
    } else if (
      (effect.kind === 'bell' ||
        (effect.kind === 'notification' && effect.source === 'osc-9')) &&
      authority.current() &&
      authority.live()
    ) {
      this.publish(session, {
        id: session.sessionId,
        instanceId: session.instanceId,
        eventSerial: effect.eventSerial,
        effect: { kind: 'bell' },
      })
    }
    // OSC777/progress are baseline no-ops. CWD/semantic/palette are native facts;
    // they grant no filesystem, extraction, configured-theme or link authority.
  }
}
