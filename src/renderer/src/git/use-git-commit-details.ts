import { useCallback, useEffect, useRef, useState } from 'react'

import type { GitCommitDetail, HostPath } from '../../../shared'
import { loadCommitDetail } from './commit-detail-client'
import { errorMessage } from './git-sync-coordinator'

export type RailCommitDetailState =
  | { readonly status: 'loading' }
  | { readonly status: 'ready'; readonly detail: GitCommitDetail }
  | { readonly status: 'error'; readonly error: string }

export function useGitCommitDetails(root: HostPath) {
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set())
  const [detailStates, setDetailStates] = useState<
    ReadonlyMap<string, RailCommitDetailState>
  >(new Map())
  const [collapsedDirectories, setCollapsedDirectories] = useState<
    ReadonlyMap<string, ReadonlySet<string>>
  >(new Map())
  const rootRef = useRef(root)
  const generation = useRef(0)
  rootRef.current = root
  const rootKey = hostPathKey(root)

  useEffect(() => {
    generation.current += 1
    setExpanded(new Set())
    setDetailStates(new Map())
    setCollapsedDirectories(new Map())
    return () => {
      generation.current += 1
    }
  }, [rootKey])

  const requestDetail = useCallback((hash: string): void => {
    const requestGeneration = generation.current
    const requestRoot = rootRef.current
    setDetailStates((current) => {
      const state = current.get(hash)
      if (state?.status === 'loading' || state?.status === 'ready') return current
      return new Map(current).set(hash, { status: 'loading' })
    })
    void loadCommitDetail(requestRoot, hash).then(
      (detail) => {
        if (generation.current !== requestGeneration) return
        setDetailStates((current) =>
          new Map(current).set(hash, { status: 'ready', detail }),
        )
      },
      (reason: unknown) => {
        if (generation.current !== requestGeneration) return
        setDetailStates((current) =>
          new Map(current).set(hash, {
            status: 'error',
            error: errorMessage(reason),
          }),
        )
      },
    )
  }, [])

  const toggleCommit = useCallback(
    (hash: string, nextExpanded?: boolean): void => {
      const shouldExpand = nextExpanded ?? !expanded.has(hash)
      if (shouldExpand === expanded.has(hash)) return
      setExpanded((current) => {
        const next = new Set(current)
        if (shouldExpand) next.add(hash)
        else next.delete(hash)
        return next
      })
      if (shouldExpand && detailStates.get(hash)?.status !== 'ready') requestDetail(hash)
    },
    [detailStates, expanded, requestDetail],
  )

  const toggleDirectory = useCallback((hash: string, path: string): void => {
    setCollapsedDirectories((current) => {
      const next = new Map(current)
      const paths = new Set(next.get(hash) ?? [])
      if (paths.has(path)) paths.delete(path)
      else paths.add(path)
      next.set(hash, paths)
      return next
    })
  }, [])

  return { expanded, detailStates, collapsedDirectories, toggleCommit, toggleDirectory }
}

function hostPathKey(path: HostPath): string {
  return `${path.hostId}\0${path.path}`
}
