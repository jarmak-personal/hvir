import { currentDirectAdd } from './direct-add.mjs'
import { escapeHtml as escape } from './html.mjs'

// Shared presentation of a bound result; this grants no mutation or recovery authority.
export function directAddResultView(state) {
  const result = currentDirectAdd(state),
    uncertain = state.directAddUncertain
  return `${result ? `<p class="add-result" role="status">${escape(result.message)}</p>${!result.pending && !result.success && result.plan.prerequisites?.length && !uncertain ? `<button ${state.curation ? 'data-curate' : 'data-action'}="review-add">Review requirements and addition…</button>` : ''}` : ''}${uncertain ? `<section class="notice add-uncertainty"><p>Add outcome remains uncertain for ${escape(uncertain.sourceIdentity)} at ${escape(uncertain.destinationHost)} · ${escape(uncertain.targetPath)}. Inspect files without retrying. Observation cannot establish this operation’s completion.</p><button data-action="inspect-add" ${state.destination !== uncertain.destination ? 'disabled' : ''}>Inspect original project in Files</button>${state.destination !== uncertain.destination ? '<p>Select the original project to inspect it.</p>' : ''}</section>` : ''}`
}
