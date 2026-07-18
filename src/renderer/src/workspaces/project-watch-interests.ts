import { useCallback, useEffect, useRef, useState } from 'react'

import {
  dirnameHostPath,
  hostPathEquals,
  MAX_PROJECT_WATCH_INTERESTS,
  type HostPath,
} from '../../../shared'

interface UseProjectWatchInterestsOptions {
  readonly root?: HostPath
  readonly connected: boolean
  readonly missing?: boolean
  readonly openPaths: readonly HostPath[]
}

export function useProjectWatchInterests({
  root,
  connected,
  missing,
  openPaths,
}: UseProjectWatchInterestsOptions) {
  const expandedPaths = useRef(new Map<string, HostPath>())
  const scope = root ? hostPathKey(root) : undefined
  const [version, setVersion] = useState(0)
  const [limited, setLimited] = useState(false)

  useEffect(() => {
    expandedPaths.current.clear()
    setLimited(false)
    setVersion((current) => current + 1)
  }, [scope])

  const updateExpandedPath = useCallback((path: HostPath, expanded: boolean): void => {
    const key = hostPathKey(path)
    if (expanded) {
      if (expandedPaths.current.has(key)) return
      expandedPaths.current.set(key, path)
    } else if (!expandedPaths.current.delete(key)) {
      return
    }
    setVersion((current) => current + 1)
  }, [])

  useEffect(() => {
    if (!root || !connected || missing) {
      setLimited(false)
      return
    }
    const unique = new Map<string, HostPath>()
    // Open files take priority because their viewer contents must stay fresh.
    for (const path of openPaths) {
      const parent = dirnameHostPath(path)
      unique.set(hostPathKey(parent), parent)
    }
    for (const path of expandedPaths.current.values()) {
      unique.set(hostPathKey(path), path)
    }
    const allPaths = [...unique.values()].filter((path) => !hostPathEquals(path, root))
    const locallyLimited = allPaths.length > MAX_PROJECT_WATCH_INTERESTS
    setLimited(locallyLimited)
    let cancelled = false
    void window.hvir
      .invoke('project:watch-interests', {
        root,
        paths: allPaths.slice(0, MAX_PROJECT_WATCH_INTERESTS),
      })
      .then((result) => {
        if (!cancelled && result.ok) setLimited(locallyLimited || result.value.limited)
      })
      .catch(() => undefined)
    return () => {
      cancelled = true
    }
  }, [connected, missing, openPaths, root, version])

  return { limited, updateExpandedPath }
}

function hostPathKey(path: HostPath): string {
  return `${path.hostId}:${path.path}`
}
