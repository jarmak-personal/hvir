/** Package-owned supported CLI guidance and current-library qualification; no host authority. */
export class SkillagerSetupError extends Error {
  constructor(state, message) {
    super(message)
    this.setupState = state
  }
}
export function connectorSetupError(reason, message) {
  return new SkillagerSetupError(
    reason === 'executable-changed'
      ? 'program-updated'
      : reason === 'unapproved'
        ? 'missing-program'
        : 'failed-observation',
    reason === 'executable-changed'
      ? 'Skillager was updated. Review its program access before running it again.'
      : message,
  )
}
export const projectInventoryRequirement =
  'Project inventory requires Skillager 0.9.7 or a supported source build.'
export const projectQueryRequirement =
  'Project filtering requires Skillager 0.9.7 or a supported source build with list --scope project --query.'
export const setupRequest = `Install or update the official Skillager CLI from https://github.com/jarmak-personal/skillager/releases or the current supported official source. Preserve my existing libraries and project skills. Verify skillager --version and the public skillager.library-status.v1, skillager.list.v1 and skillager.search.v1 contracts with pagination. ${projectInventoryRequirement} ${projectQueryRequirement} Verify list --scope project --query with pagination. Verify library source grouping with list --scope library --json --group-by source (skillager.library-groups.v1) and --source-group filtering. Do not initialize a library or change project setup without my explicit decision. Show me the installed executable so I can choose Connect Skillager in hvir.`

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
export function firstUseFailure(
  error,
  retained = false,
  destination = 'library',
  canConnect = false,
) {
  const state = error.setupState ?? 'failed-observation'
  const project = destination === 'project'
  return {
    state: retained ? 'stale' : state,
    setup: ['missing-program', 'program-updated', 'update-required'].includes(state),
    message: `${state === 'program-updated' ? (canConnect ? 'Skillager was updated. Choose Connect Skillager to review its program access.' : 'Skillager was updated. Review its program access in Settings → Extensions.') : state === 'missing-program' ? (project ? (canConnect ? 'Skillager is not connected for this project. Choose Connect Skillager here to discover its skills.' : 'Skillager is not connected for this project. Open Settings → Extensions → Project program access to choose and approve its program.') : canConnect ? 'Skillager is not connected. Set it up, then choose Connect Skillager.' : 'Skillager is not connected. Open Settings → Extensions → Program access to choose and approve its program.') : state === 'update-required' ? (project ? 'Update Skillager to load project skills.' : 'Update Skillager to a supported current public contract.') : project ? (retained ? 'Could not refresh project skills. Showing the last result.' : 'Could not load skills in this project.') : 'Skillager could not observe your library.'}${retained && (!project || state !== 'failed-observation') ? ' Last-known rows retained; freshness unavailable.' : ''}`,
    detail: error.message,
  }
}
