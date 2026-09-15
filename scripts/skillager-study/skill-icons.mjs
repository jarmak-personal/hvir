import { escapeHtml as escape } from './html.mjs'

export const instructionIcon =
  '<svg class="instruction-icon" viewBox="0 0 20 20" aria-hidden="true"><path d="M6 2h7l4 4v11H6zM13 2v5h4M3 5v14h11M9 10h5M9 13h5" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/></svg>'
export function copyGlyphs(agent, mode) {
  const label = `${agent === 'claude' ? 'Claude Code' : 'Codex'} · ${mode}`
  return `<span class="copy-glyphs" role="img" aria-label="${escape(label)}" title="${escape(label)}"><span aria-hidden="true">${agent === 'claude' ? '✳' : '▣'} ${mode === 'Original' ? '▱' : mode === 'Router' ? '⑂' : '↗'}</span></span>`
}
