import type { ReactElement, ComponentProps } from 'react'
import { GIT_CHANGE_DISPLAY_LIMIT } from '../../../shared'
import { FileTree } from '../tree/FileTree'
import { GitPanel } from '../git/GitPanel'
import { ExtensionLeftRail } from '../extensions/ExtensionContributions'
export function WorkbenchProjectRail({
  files,
  git,
  mode,
  onMode,
  gitEnabled,
  changedCount,
  changesLimited,
  visible,
}: {
  readonly files: ComponentProps<typeof FileTree>
  readonly git?: ComponentProps<typeof GitPanel>
  readonly mode: 'files' | 'git'
  readonly onMode: (mode: 'files' | 'git') => void
  readonly gitEnabled: boolean
  readonly changedCount: number
  readonly changesLimited?: boolean
  readonly visible: boolean
}): ReactElement {
  const changedLabel =
    changedCount > 0
      ? changesLimited
        ? `${GIT_CHANGE_DISPLAY_LIMIT.toLocaleString()}+`
        : changedCount.toLocaleString()
      : undefined
  return (
    <aside
      className="tree-panel"
      aria-label="Project rail"
      data-diagnostic-capture="project-navigation"
      tabIndex={-1}
    >
      <ExtensionLeftRail visible={visible}>
        <nav className="rail-nav" aria-label="Project views">
          <button
            type="button"
            className={mode === 'files' ? 'active' : ''}
            aria-current={mode === 'files' ? 'page' : undefined}
            onClick={() => onMode('files')}
          >
            Files
          </button>
          {gitEnabled ? (
            <button
              type="button"
              className={mode === 'git' ? 'active' : ''}
              aria-current={mode === 'git' ? 'page' : undefined}
              onClick={() => onMode('git')}
            >
              Git{changedLabel ? ` ${changedLabel}` : ''}
            </button>
          ) : null}
        </nav>
        <div className="rail-content">
          <FileTree key={`files:${files.root.hostId}:${files.root.path}`} {...files} />
          {git ? (
            <GitPanel key={`git:${git.root.hostId}:${git.root.path}`} {...git} />
          ) : null}
        </div>
      </ExtensionLeftRail>
    </aside>
  )
}
