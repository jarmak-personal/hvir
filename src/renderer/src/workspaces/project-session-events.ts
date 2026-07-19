import type { HvirApi, ProjectState, SshPromptRequest, WatchEvent } from '../../../shared'

export interface ProjectSessionEventHandlers {
  readonly onWatch: (event: WatchEvent) => void
  readonly onState: (state: ProjectState) => void
  readonly onPrompt: (prompt: SshPromptRequest) => void
  readonly onPromptCancel: (hostId: string) => void
}

/** Subscribe to the complete project-session event surface as one lease. */
export function subscribeProjectSessionEvents(
  events: Pick<HvirApi, 'on'>,
  handlers: ProjectSessionEventHandlers,
): () => void {
  const disposers = [
    events.on('project:watch', handlers.onWatch),
    events.on('project:state', handlers.onState),
    events.on('ssh:prompt', handlers.onPrompt),
    events.on('ssh:prompt-cancel', ({ hostId }) => handlers.onPromptCancel(hostId)),
  ]
  let disposed = false
  return () => {
    if (disposed) return
    disposed = true
    for (const dispose of disposers) void dispose()
  }
}
