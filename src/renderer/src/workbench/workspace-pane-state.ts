import type { HostPath } from '../../../shared'

export type TerminalLayoutMode = 'collapsed' | 'restored' | 'maximized'

export interface WorkspacePaneState {
  readonly terminalMode: TerminalLayoutMode
  readonly terminalRailCompact: boolean
  readonly treeCollapsed: boolean
}

export const DEFAULT_WORKSPACE_PANE_STATE: WorkspacePaneState = {
  terminalMode: 'restored',
  terminalRailCompact: false,
  treeCollapsed: false,
}

/** Session-only pane memory keyed by the complete host-qualified workspace root. */
export class WorkspacePaneStateSession {
  readonly #states = new Map<string, WorkspacePaneState>()

  read(root: HostPath): WorkspacePaneState {
    return this.#states.get(workspaceKey(root)) ?? DEFAULT_WORKSPACE_PANE_STATE
  }

  write(root: HostPath, state: WorkspacePaneState): void {
    this.#states.set(workspaceKey(root), state)
  }
}

function workspaceKey(root: HostPath): string {
  return JSON.stringify([root.hostId, root.path])
}
