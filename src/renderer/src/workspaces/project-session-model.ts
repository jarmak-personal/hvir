import {
  hostPathEquals,
  type HostConnectionState,
  type HostWatchTier,
  type ProjectState,
  type SshPromptRequest,
} from '../../../shared'

export interface ProjectSessionModel {
  readonly projectState?: ProjectState
  readonly connectionState: HostConnectionState
  readonly watchTier: HostWatchTier
  readonly busy: boolean
  readonly error?: string
  readonly prompts: readonly SshPromptRequest[]
  readonly generation: number
}

/** Feature-neutral attention input supplied by harness/terminal surfaces. */
export interface WorkspaceAttentionRollup {
  readonly actionable: number
}

export type WorkspaceAttentionRollups = Readonly<Record<string, WorkspaceAttentionRollup>>

export type ProjectSessionAction =
  | { readonly type: 'transition-started'; readonly generation: number }
  | {
      readonly type: 'transition-project'
      readonly generation: number
      readonly state: ProjectState
    }
  | {
      readonly type: 'transition-connection'
      readonly generation: number
      readonly connectionState: HostConnectionState
      readonly watchTier?: HostWatchTier
    }
  | {
      readonly type: 'transition-failed'
      readonly generation: number
      readonly error: string
    }
  | { readonly type: 'transition-finished'; readonly generation: number }
  | { readonly type: 'project-state'; readonly state: ProjectState }
  | { readonly type: 'prompt-received'; readonly prompt: SshPromptRequest }
  | { readonly type: 'prompts-cancelled'; readonly hostId: string }
  | { readonly type: 'prompt-answered'; readonly id: number }
  | { readonly type: 'reported-error'; readonly error?: string }

export const initialProjectSessionModel: ProjectSessionModel = {
  connectionState: 'connected',
  watchTier: 'native',
  busy: false,
  prompts: [],
  generation: 0,
}

export function projectSessionReducer(
  model: ProjectSessionModel,
  action: ProjectSessionAction,
): ProjectSessionModel {
  switch (action.type) {
    case 'transition-started':
      if (action.generation <= model.generation) return model
      return {
        ...model,
        generation: action.generation,
        busy: true,
        error: undefined,
      }
    case 'transition-project':
      if (action.generation !== model.generation) return model
      return applyProjectState(model, action.state)
    case 'transition-connection':
      if (action.generation !== model.generation) return model
      return {
        ...model,
        connectionState: action.connectionState,
        watchTier: action.watchTier ?? model.watchTier,
      }
    case 'transition-failed':
      if (action.generation !== model.generation) return model
      return { ...model, error: action.error }
    case 'transition-finished':
      if (action.generation !== model.generation) return model
      return { ...model, busy: false }
    case 'project-state': {
      const next = applyProjectState(model, action.state)
      return action.state.connectionState === 'disconnected'
        ? {
            ...next,
            prompts: next.prompts.filter(
              (prompt) => prompt.hostId !== action.state.root.hostId,
            ),
          }
        : next
    }
    case 'prompt-received':
      return model.prompts.some((prompt) => prompt.id === action.prompt.id)
        ? model
        : { ...model, prompts: [...model.prompts, action.prompt] }
    case 'prompts-cancelled':
      return {
        ...model,
        prompts: model.prompts.filter((prompt) => prompt.hostId !== action.hostId),
      }
    case 'prompt-answered':
      return {
        ...model,
        prompts: model.prompts.filter((prompt) => prompt.id !== action.id),
      }
    case 'reported-error':
      return { ...model, error: action.error }
  }
}

export function selectActiveProject(model: ProjectSessionModel) {
  const state = model.projectState
  return state?.projects.find((project) => project.id === state.activeProjectId)
}

export function selectActiveWorkspace(model: ProjectSessionModel) {
  const state = model.projectState
  const project = selectActiveProject(model)
  return project?.workspaces.find(
    (workspace) => workspace.id === state?.activeWorkspaceId,
  )
}

export function selectRelativeWorkspace(
  model: ProjectSessionModel,
  direction: -1 | 1,
): { readonly projectId: string; readonly workspaceId: string } | undefined {
  const state = model.projectState
  const project = selectActiveProject(model)
  const available = project?.workspaces.filter((workspace) => !workspace.missing) ?? []
  if (!state || !project || available.length < 2) return undefined
  const currentIndex = available.findIndex(
    (workspace) => workspace.id === state.activeWorkspaceId,
  )
  const target =
    available[(currentIndex + direction + available.length) % available.length]
  return target ? { projectId: project.id, workspaceId: target.id } : undefined
}

function applyProjectState(
  model: ProjectSessionModel,
  state: ProjectState,
): ProjectSessionModel {
  const projectState =
    model.projectState && hostPathEquals(model.projectState.root, state.root)
      ? { ...state, root: model.projectState.root }
      : state
  return {
    ...model,
    projectState,
    connectionState: state.connectionState,
    watchTier: state.watchTier,
    ...(state.connectionState === 'connected' ? { error: undefined } : {}),
  }
}
