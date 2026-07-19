import type { HostPath } from '../../../shared'

export interface WorkspaceLayout {
  readonly version: 1
  readonly treeWidth?: number
  readonly terminalHeight?: number
  readonly viewerSplit?: boolean
  readonly viewerPrimaryWidth?: number
}

export type WorkspaceLayoutUpdate = Omit<Partial<WorkspaceLayout>, 'version'>

export function restoreWorkspaceLayout(root: HostPath): WorkspaceLayout {
  try {
    return decodeWorkspaceLayout(
      localStorage.getItem(`hvir:layout:${root.hostId}:${root.path}`),
    )
  } catch {
    return { version: 1 }
  }
}

export function persistWorkspaceLayout(
  root: HostPath,
  update: WorkspaceLayoutUpdate,
): void {
  try {
    localStorage.setItem(
      `hvir:layout:${root.hostId}:${root.path}`,
      JSON.stringify({ ...restoreWorkspaceLayout(root), ...update }),
    )
  } catch {
    // Layout recovery is best effort and never blocks the live workbench.
  }
}

export function decodeWorkspaceLayout(raw: string | null): WorkspaceLayout {
  try {
    const parsed: unknown = JSON.parse(raw ?? 'null')
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { version: 1 }
    }
    const layout = parsed as Record<string, unknown>
    return {
      version: 1,
      treeWidth: finiteNumber(layout['treeWidth']),
      terminalHeight: finiteNumber(layout['terminalHeight']),
      viewerSplit:
        typeof layout['viewerSplit'] === 'boolean' ? layout['viewerSplit'] : undefined,
      viewerPrimaryWidth: finiteNumber(layout['viewerPrimaryWidth']),
    }
  } catch {
    return { version: 1 }
  }
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}
