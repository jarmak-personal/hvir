import type { NativeTerminalProductEffect } from '../../../shared/native-terminal-effects'
import type { TerminalEvent } from './terminal-pane'
/** One pane receives only its current immutable binding's product effects. */
export class NativeTerminalPaneEffects {
  private readonly serial = { title: 0, bell: 0 }
  private readonly listeners = new Set<(event: TerminalEvent) => void>()
  constructor(
    private readonly current: () => {
      sessionId?: string
      instanceId?: string
      disposed: boolean
    },
  ) {}
  accept(value: NativeTerminalProductEffect): void {
    const current = this.current()
    if (
      current.disposed ||
      value.id !== current.sessionId ||
      !current.instanceId ||
      value.instanceId !== current.instanceId ||
      !Number.isSafeInteger(value.eventSerial) ||
      value.eventSerial <= 0
    )
      return
    if (value.effect.kind !== 'title' && value.effect.kind !== 'bell') return
    if (value.eventSerial <= this.serial[value.effect.kind]) return
    this.serial[value.effect.kind] = value.eventSerial
    const event: TerminalEvent =
      value.effect.kind === 'title'
        ? { type: 'title', title: value.effect.title }
        : { type: 'bell' }
    for (const listener of this.listeners) listener(event)
  }
  restoreTitle(
    title: { readonly title: string; readonly eventSerial: number } | undefined,
  ): void {
    const current = this.current()
    if (title && current.sessionId && current.instanceId)
      this.accept({
        id: current.sessionId,
        instanceId: current.instanceId,
        eventSerial: title.eventSerial,
        effect: { kind: 'title', title: title.title },
      })
  }
  subscribe(listener: (event: TerminalEvent) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }
  clear(): void {
    this.listeners.clear()
  }
}
