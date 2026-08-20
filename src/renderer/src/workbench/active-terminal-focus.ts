const ACTIVE_TERMINAL_INPUT =
  '.terminal-deck:not([hidden]) .terminal-surface.visible.active .terminal-container'

export function focusActiveTerminalAfterLayout(): void {
  window.requestAnimationFrame(() => {
    document.querySelector<HTMLElement>(ACTIVE_TERMINAL_INPUT)?.focus()
  })
}

export function focusVisibleActiveTerminalAfterLayout(): void {
  window.requestAnimationFrame(() => {
    const input = document.querySelector<HTMLElement>(ACTIVE_TERMINAL_INPUT)
    const deck = input?.closest<HTMLElement>('.terminal-deck')
    if (!input || !deck) return
    const style = getComputedStyle(deck)
    if (style.visibility === 'hidden' || style.display === 'none') return
    input.focus()
  })
}
