/** Build the same normalized target for guest navigation and browser handoff. */
export function webPaneUrlFromInput(origin: string, pathInput: string): string {
  const trimmed = pathInput.trim()
  const path = trimmed.startsWith('/') ? trimmed : `/${trimmed}`
  return `${origin}${path}`
}
