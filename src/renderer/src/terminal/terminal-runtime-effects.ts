import type { TerminalEvent } from './terminal-pane'
import type { TerminalPaneEventCoordinator } from './terminal-pane-event-coordinator'
import { writeClipboardFromOsc } from './terminal-clipboard-write'
/** Applies the existing product effects equally for either pane engine. */
export function terminalRuntimeEffectListener(
  events: Pick<TerminalPaneEventCoordinator, 'handle'>,
  ports: { title(title: string): void; bell(): void; live(): boolean },
): (event: TerminalEvent) => void {
  return (event) => {
    const effect = events.handle(event)
    if (effect && 'title' in effect) ports.title(effect.title)
    else if (effect && 'bell' in effect) ports.bell()
    else if (effect && 'clipboardWrite' in effect && ports.live())
      writeClipboardFromOsc(effect.clipboardWrite)
  }
}
