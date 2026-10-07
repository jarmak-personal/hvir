/** Package-owned supported CLI guidance and current-library qualification; no host authority. */
export class SkillagerSetupError extends Error {
  constructor(state, message) {
    super(message)
    this.setupState = state
  }
}
export const setupRequest = `Set up the official Skillager CLI for hvir without changing my existing libraries or project skills. Use https://github.com/jarmak-personal/skillager and a supported public source containing PR #75 (https://github.com/jarmak-personal/skillager/pull/75), merged as 79d2bfc63a2c7fb992d8b51729c563b6ba27ebc4, or a later official release that includes those contracts. Version 0.9.3 alone is insufficient: that release predates PR #75. Verify skillager --version and the public skillager.library-status.v1, skillager.list.v1 and skillager.search.v1 schemas with pagination. Do not initialize a library or modify its files without my explicit decision. Show me the installed executable so I can approve it in hvir.`
export function sameCurrentLibrary(selected, current) {
  if (
    !current.initialized ||
    !selected ||
    current.id !== selected.id ||
    (selected.root && current.root !== selected.root)
  )
    throw new Error(
      'Your personal library changed. Return to Your library and select the current skill again; no source was substituted.',
    )
  return current
}
export function firstUseFailure(error, retained = false) {
  const state = error.setupState ?? 'failed-observation'
  return {
    state: retained ? 'stale' : state,
    setup: ['missing-program', 'update-required'].includes(state),
    message: `${state === 'missing-program' ? 'Skillager is not connected. Set it up, then choose Connect Skillager.' : state === 'update-required' ? 'Update Skillager to a supported current public contract.' : 'Skillager could not observe your library.'}${retained ? ' Last-known rows retained; freshness unavailable.' : ''}`,
    detail: error.message,
  }
}
