const ACTIVE_TERMINAL_INPUT =
  '.terminal-deck:not([hidden]) .terminal-surface.active .terminal-container'

export function focusActiveTerminalAfterLayout(): void {
  window.requestAnimationFrame(() => {
    document.querySelector<HTMLElement>(ACTIVE_TERMINAL_INPUT)?.focus()
  })
}
