export function sanitizedWebPaneTitle(title: string): string {
  const normalized = [...title]
    .map((character) => {
      const codepoint = character.codePointAt(0) ?? 0
      return codepoint < 32 || codepoint === 127 ? ' ' : character
    })
    .join('')
    .trim()
  return normalized.slice(0, 120) || 'Web pane'
}
