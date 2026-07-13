import { useEffect, useRef, useState, type ReactElement } from 'react'

import {
  basenameHostPath,
  type DiffBase,
  type GitChanges,
  type GitCommitSummary,
  type GitCommitDetail,
  type HostPath,
  type HostConnectionState,
  type HostWatchTier,
} from '../../../shared'
import { SessionBar } from '../tree/FileTree'

interface GitPanelProps {
  readonly root: HostPath
  readonly refreshVersion: number
  readonly onShowFiles: () => void
  readonly onOpen: (path: HostPath, base: DiffBase, revision?: string) => void
  readonly onChangedCount: (count: number) => void
  readonly connectionState?: HostConnectionState
  readonly watchTier?: HostWatchTier
  readonly sessionLabel: string
  readonly onChangeSession: () => void
  readonly onDisconnectSession: () => void
  readonly onReconnectSession: () => void
  readonly sessionBusy?: boolean
  readonly sessionError?: string
}

export function GitPanel({
  root,
  refreshVersion,
  onShowFiles,
  onOpen,
  onChangedCount,
  connectionState = 'connected',
  watchTier = 'native',
  sessionLabel,
  onChangeSession,
  onDisconnectSession,
  onReconnectSession,
  sessionBusy = false,
  sessionError,
}: GitPanelProps): ReactElement {
  const [view, setView] = useState<'changes' | 'history'>('changes')
  const [changes, setChanges] = useState<GitChanges>()
  const [commits, setCommits] = useState<readonly GitCommitSummary[]>([])
  const [hasMore, setHasMore] = useState(false)
  const [error, setError] = useState<string>()
  const [detail, setDetail] = useState<GitCommitDetail>()
  const historyEnd = useRef<HTMLDivElement>(null)
  const historyLoading = useRef(false)

  useEffect(() => {
    if (connectionState !== 'connected') return
    let cancelled = false
    void window.hvir.invoke('git:changes', { root }).then(
      (result) => {
        if (!cancelled) {
          setChanges(result)
          onChangedCount(result.workingTree.length)
        }
      },
      (reason: unknown) => {
        if (!cancelled)
          setError(reason instanceof Error ? reason.message : String(reason))
      },
    )
    return () => {
      cancelled = true
    }
  }, [connectionState, onChangedCount, refreshVersion, root])

  const loadHistory = (): void => {
    if (connectionState !== 'connected' || historyLoading.current || !hasMore) return
    historyLoading.current = true
    void window.hvir
      .invoke('git:history', { root, skip: commits.length, limit: 50 })
      .then(
        (page) => {
          setCommits((current) => [...current, ...page.commits])
          setHasMore(page.hasMore)
        },
        (reason: unknown) =>
          setError(reason instanceof Error ? reason.message : String(reason)),
      )
      .finally(() => {
        historyLoading.current = false
      })
  }

  useEffect(() => {
    if (view !== 'history' || connectionState !== 'connected') return
    let cancelled = false
    void window.hvir.invoke('git:history', { root, skip: 0, limit: 50 }).then(
      (page) => {
        if (!cancelled) {
          setCommits(page.commits)
          setHasMore(page.hasMore)
        }
      },
      (reason: unknown) => {
        if (!cancelled)
          setError(reason instanceof Error ? reason.message : String(reason))
      },
    )
    return () => {
      cancelled = true
    }
  }, [connectionState, root, view])

  useEffect(() => {
    const target = historyEnd.current
    if (view !== 'history' || !target || !hasMore) return
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) loadHistory()
      },
      { root: target.closest('.git-scroll'), rootMargin: '120px' },
    )
    observer.observe(target)
    return () => observer.disconnect()
    // Pagination state intentionally re-arms the sentinel for the next page.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [commits.length, connectionState, hasMore, view])

  return (
    <section className="tree-panel git-panel" aria-label="Git">
      <SessionBar
        label={sessionLabel}
        remote={root.hostId !== 'local'}
        connectionState={connectionState}
        watchTier={watchTier}
        onChange={onChangeSession}
        onDisconnect={onDisconnectSession}
        onReconnect={onReconnectSession}
        busy={sessionBusy}
        error={sessionError}
      />
      <header className="panel-header">
        <span>Git</span>
        <span className="panel-meta">{basenameHostPath(root)}</span>
        <button className="rail-switch" onClick={onShowFiles}>
          Files
        </button>
      </header>
      <div className="git-tabs">
        <button
          className={view === 'changes' ? 'active' : ''}
          onClick={() => setView('changes')}
        >
          Changes {changes ? `(${changes.workingTree.length})` : ''}
        </button>
        <button
          className={view === 'history' ? 'active' : ''}
          onClick={() => setView('history')}
        >
          History
        </button>
      </div>
      <div className="tree-scroll git-scroll">
        {error ? <div className="tree-error">{error}</div> : null}
        {view === 'changes' ? (
          <>
            <ChangeGroup
              title="Working tree"
              files={changes?.workingTree ?? []}
              base="head"
              onOpen={onOpen}
            />
            <ChangeGroup
              title="Branch point"
              files={changes?.branchPoint ?? []}
              base="branch-point"
              onOpen={onOpen}
            />
          </>
        ) : (
          <div className="git-history">
            {commits.map((commit) => (
              <div className="git-commit-entry" key={commit.hash}>
                <button
                  type="button"
                  className="git-commit"
                  onClick={() => {
                    if (detail?.hash === commit.hash) {
                      setDetail(undefined)
                      return
                    }
                    void window.hvir
                      .invoke('git:commit-detail', { root, hash: commit.hash })
                      .then(setDetail, (reason: unknown) =>
                        setError(
                          reason instanceof Error ? reason.message : String(reason),
                        ),
                      )
                  }}
                >
                  <strong>{commit.subject}</strong>
                  <span>
                    {commit.shortHash} · {commit.author}
                  </span>
                </button>
                {detail?.hash === commit.hash ? (
                  <div className="git-commit-detail">
                    <p>{detail.message}</p>
                    {detail.files.map((file) => (
                      <button
                        type="button"
                        className="git-file"
                        key={`${file.path.hostId}:${file.path.path}`}
                        onClick={() => onOpen(file.path, 'head', commit.hash)}
                      >
                        <span>{basenameHostPath(file.path)}</span>
                        <small>
                          <b>+{file.additions}</b> <i>-{file.deletions}</i>
                        </small>
                      </button>
                    ))}
                  </div>
                ) : null}
              </div>
            ))}
            {hasMore ? (
              <button className="git-load-more" onClick={loadHistory}>
                Load more
              </button>
            ) : null}
            <div ref={historyEnd} className="git-history-end" />
          </div>
        )}
      </div>
    </section>
  )
}

function ChangeGroup({
  title,
  files,
  base,
  onOpen,
}: {
  readonly title: string
  readonly files: GitChanges['workingTree']
  readonly base: DiffBase
  readonly onOpen: (path: HostPath, base: DiffBase, revision?: string) => void
}): ReactElement {
  return (
    <div className="git-group">
      <h3>
        {title}
        <span>{files.length}</span>
      </h3>
      {files.map((file) => (
        <button
          className="git-file"
          key={`${file.path.hostId}:${file.path.path}`}
          onClick={() => onOpen(file.path, base)}
          title={file.path.path}
        >
          <span>{basenameHostPath(file.path)}</span>
          <small>
            {file.conflicted
              ? '!'
              : file.untracked
                ? '?'
                : file.staged && file.unstaged
                  ? '±'
                  : file.staged
                    ? 'S'
                    : 'M'}{' '}
            <b>+{file.additions}</b> <i>-{file.deletions}</i>
          </small>
        </button>
      ))}
    </div>
  )
}
