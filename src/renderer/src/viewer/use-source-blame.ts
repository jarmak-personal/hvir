import { useEffect, useState } from 'react'
import type { GitBlameRun, HostPath, ViewMode } from '../../../shared'

export function useSourceBlame(
  currentPath: HostPath | undefined,
  blameMode: ViewMode | undefined,
  showBlame: boolean,
  documentRefreshVersion: number,
  gitRefreshVersion: number,
) {
  const [blame, setBlame] = useState<readonly GitBlameRun[]>([])
  const [blameStatus, setBlameStatus] = useState('')
  useEffect(() => {
    if (!showBlame || !currentPath || blameMode !== 'source') return
    let cancelled = false
    setBlame([])
    setBlameStatus('blame loading…')
    void window.hvir.invoke('git:blame', { path: currentPath }).then(
      (runs) => {
        if (!cancelled) {
          setBlame(runs)
          setBlameStatus(
            `${runs.reduce((total, run) => total + run.lineCount, 0)} blamed lines · ${runs.length} runs`,
          )
        }
      },
      (reason: unknown) => {
        if (!cancelled) {
          setBlame([])
          setBlameStatus(
            `blame unavailable: ${reason instanceof Error ? reason.message : String(reason)}`,
          )
        }
      },
    )
    return () => {
      cancelled = true
    }
  }, [blameMode, currentPath, documentRefreshVersion, gitRefreshVersion, showBlame])

  return { blame, blameStatus }
}
