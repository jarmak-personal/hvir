/** Enabled menu-item navigation shared by menus; event phases and dismissal stay with owners. */
function enabledMenuItems(menu: HTMLElement): HTMLButtonElement[] {
  return [...menu.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].filter(
    (item) => !item.disabled,
  )
}
export function firstEnabledMenuItem(menu: HTMLElement): HTMLButtonElement | undefined {
  return enabledMenuItems(menu)[0]
}
export function focusRelativeMenuItem(menu: HTMLElement, key: string): boolean {
  if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(key)) return false
  const items = enabledMenuItems(menu)
  if (!items.length) return false
  const index = items.indexOf(document.activeElement as HTMLButtonElement)
  const next =
    key === 'Home'
      ? 0
      : key === 'End'
        ? items.length - 1
        : key === 'ArrowUp'
          ? (index - 1 + items.length) % items.length
          : (index + 1) % items.length
  items[next]?.focus()
  return true
}
