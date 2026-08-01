import {
  RETAINED_CLEAN_BYTE_LIMIT,
  RETAINED_CLEAN_FILE_LIMIT,
  RETAINED_WORKSPACE_LIMIT,
} from './viewer-workload-policy'
import type { ViewerTab } from './tab-state'
import type { RestoredViewerTabs } from './viewer-workspace-persistence'

export interface RetainedViewerWorkspaceLimits {
  readonly workspaces: number
  readonly cleanFiles: number
  readonly cleanBytes: number
}

const DEFAULT_LIMITS: RetainedViewerWorkspaceLimits = {
  workspaces: RETAINED_WORKSPACE_LIMIT,
  cleanFiles: RETAINED_CLEAN_FILE_LIMIT,
  cleanBytes: RETAINED_CLEAN_BYTE_LIMIT,
}

/**
 * Process-lifetime workspace retention. Clean bodies are an expendable LRU;
 * dirty drafts are authoritative and therefore exempt from every cache budget.
 */
export class RetainedViewerWorkspaceCache {
  private readonly entries = new Map<string, RestoredViewerTabs>()

  constructor(private readonly limits: RetainedViewerWorkspaceLimits = DEFAULT_LIMITS) {}

  set(key: string, workspace: RestoredViewerTabs): void {
    this.entries.delete(key)
    this.entries.set(key, workspace)
    this.enforceCleanBodyBudget()
    this.enforceWorkspaceBudget()
  }

  take(key: string): RestoredViewerTabs | undefined {
    const workspace = this.entries.get(key)
    if (workspace) this.entries.delete(key)
    return workspace
  }

  stats(): {
    readonly workspaces: number
    readonly cleanFiles: number
    readonly cleanBytes: number
  } {
    let cleanFiles = 0
    let cleanBytes = 0
    for (const workspace of this.entries.values()) {
      for (const tab of workspace.tabs) {
        if (!tab.dirty && tab.file) {
          cleanFiles++
          cleanBytes += tab.file.size
        }
      }
    }
    return { workspaces: this.entries.size, cleanFiles, cleanBytes }
  }

  private enforceCleanBodyBudget(): void {
    let { cleanFiles, cleanBytes } = this.stats()
    if (cleanFiles <= this.limits.cleanFiles && cleanBytes <= this.limits.cleanBytes) {
      return
    }
    for (const [key, workspace] of this.entries) {
      let changed = false
      const tabs = workspace.tabs.map((tab) => {
        if (
          tab.dirty ||
          !tab.file ||
          (cleanFiles <= this.limits.cleanFiles && cleanBytes <= this.limits.cleanBytes)
        ) {
          return tab
        }
        cleanFiles--
        cleanBytes -= tab.file.size
        changed = true
        return evictCleanBody(tab)
      })
      if (changed) this.entries.set(key, { ...workspace, tabs })
      if (cleanFiles <= this.limits.cleanFiles && cleanBytes <= this.limits.cleanBytes) {
        return
      }
    }
  }

  private enforceWorkspaceBudget(): void {
    while (this.entries.size > this.limits.workspaces) {
      const evictable = [...this.entries].find(([, workspace]) =>
        workspace.tabs.every((tab) => !tab.dirty),
      )
      if (!evictable) return
      this.entries.delete(evictable[0])
    }
  }
}

function evictCleanBody(tab: ViewerTab): ViewerTab {
  return {
    ...tab,
    file: undefined,
    loading: true,
    error: undefined,
  }
}
