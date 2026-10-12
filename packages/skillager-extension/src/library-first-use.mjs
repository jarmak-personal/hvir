/** Package-owned supported CLI guidance and current-library qualification; no host authority. */
export class SkillagerSetupError extends Error {
  constructor(state, message) {
    super(message)
    this.setupState = state
  }
}
export const setupRequest = `Install or update the official Skillager CLI from https://github.com/jarmak-personal/skillager/releases/tag/v0.9.5 or a newer official release. Preserve my existing libraries and project skills. Verify skillager --version and the public skillager.library-status.v1, skillager.list.v1 and skillager.search.v1 contracts with pagination. Do not initialize a library or change project setup without my explicit decision. Show me the installed executable so I can choose Connect Skillager in hvir.`

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
export function firstUseFailure(error, retained = false, destination = 'library') {
  const state = error.setupState ?? 'failed-observation'
  const project = destination === 'project'
  return {
    state: retained ? 'stale' : state,
    setup: ['missing-program', 'update-required'].includes(state),
    message: `${state === 'missing-program' ? (project ? 'Skillager is not connected for this project. Choose Connect Skillager here to discover its skills.' : 'Skillager is not connected. Set it up, then choose Connect Skillager.') : state === 'update-required' ? 'Update Skillager to a supported current public contract.' : project ? 'Skillager could not observe this project. Your personal library stays separate.' : 'Skillager could not observe your library.'}${retained ? ' Last-known rows retained; freshness unavailable.' : ''}`,
    detail: error.message,
  }
}
