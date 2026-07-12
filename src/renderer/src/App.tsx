import { useEffect, useRef, useState, type ReactElement } from 'react'

import type { HostPath, ReadFileResponse } from '../../shared'
import { PaneResizer } from './layout/PaneResizer'
import { TerminalView } from './terminal/TerminalView'
import { FileTree } from './tree/FileTree'
import { FileViewer } from './viewer/FileViewer'

const TREE_MIN_WIDTH = 160
const TREE_MAX_WIDTH = 520
const MAIN_MIN_WIDTH = 420
const VIEWER_MIN_HEIGHT = 180
const TERMINAL_MIN_HEIGHT = 160
const DIVIDER_SIZE = 5

export function App(): ReactElement {
  const workbenchRef = useRef<HTMLElement>(null)
  const [root, setRoot] = useState<HostPath>()
  const [rootError, setRootError] = useState<string>()
  const [watchVersion, setWatchVersion] = useState(0)
  const [selected, setSelected] = useState<HostPath>()
  const [file, setFile] = useState<ReadFileResponse>()
  const [fileLoading, setFileLoading] = useState(false)
  const [fileError, setFileError] = useState<string>()

  useEffect(() => {
    let cancelled = false
    let watchRefreshTimer: number | undefined
    void window.hvir
      .invoke('project:root', undefined)
      .then(({ root: projectRoot }) => {
        if (!cancelled) setRoot(projectRoot)
      })
      .catch((error: unknown) => {
        if (!cancelled)
          setRootError(error instanceof Error ? error.message : String(error))
      })
    const stopWatch = window.hvir.on('project:watch', () => {
      if (watchRefreshTimer !== undefined) return
      // Main already collapses raw chokidar churn. This second, coarser gate
      // bounds the number of open-directory readdir refreshes and React commits.
      watchRefreshTimer = window.setTimeout(() => {
        watchRefreshTimer = undefined
        setWatchVersion((version) => version + 1)
      }, 250)
    })
    return () => {
      cancelled = true
      if (watchRefreshTimer !== undefined) window.clearTimeout(watchRefreshTimer)
      void stopWatch()
    }
  }, [])

  const openFile = (path: HostPath): void => {
    setSelected(path)
    setFileLoading(true)
    setFileError(undefined)
    void window.hvir
      .invoke('fs:read', { path })
      .then((nextFile) => setFile(nextFile))
      .catch((error: unknown) => {
        setFile(undefined)
        setFileError(error instanceof Error ? error.message : String(error))
      })
      .finally(() => setFileLoading(false))
  }

  const setTreeWidth = (width: number): void => {
    const workbench = workbenchRef.current
    if (!workbench) return
    const max = Math.max(
      TREE_MIN_WIDTH,
      Math.min(TREE_MAX_WIDTH, workbench.clientWidth - DIVIDER_SIZE - MAIN_MIN_WIDTH),
    )
    workbench.style.setProperty('--tree-track', `${clamp(width, TREE_MIN_WIDTH, max)}px`)
  }

  const setTerminalHeight = (height: number): void => {
    const workbench = workbenchRef.current
    if (!workbench) return
    const max = Math.max(
      TERMINAL_MIN_HEIGHT,
      workbench.clientHeight - DIVIDER_SIZE - VIEWER_MIN_HEIGHT,
    )
    workbench.style.setProperty(
      '--terminal-track',
      `${clamp(height, TERMINAL_MIN_HEIGHT, max)}px`,
    )
  }

  if (rootError) return <div className="startup-error">{rootError}</div>
  if (!root) return <div className="startup-loading">Starting hvir…</div>

  return (
    <main className="workbench" ref={workbenchRef}>
      <FileTree
        root={root}
        refreshVersion={watchVersion}
        selected={selected}
        onSelect={openFile}
      />
      <PaneResizer
        orientation="vertical"
        className="tree-resizer"
        label="Resize file tree"
        onDrag={(clientX) => {
          const left = workbenchRef.current?.getBoundingClientRect().left ?? 0
          setTreeWidth(clientX - left)
        }}
        onNudge={(delta) => {
          const current = workbenchRef.current?.querySelector<HTMLElement>('.tree-panel')
          if (current) setTreeWidth(current.getBoundingClientRect().width + delta)
        }}
        onReset={() => workbenchRef.current?.style.removeProperty('--tree-track')}
      />
      <FileViewer file={file} loading={fileLoading} error={fileError} />
      <PaneResizer
        orientation="horizontal"
        className="terminal-resizer"
        label="Resize terminal"
        onDrag={(clientY) => {
          const bottom = workbenchRef.current?.getBoundingClientRect().bottom ?? 0
          setTerminalHeight(bottom - clientY)
        }}
        onNudge={(delta) => {
          const current =
            workbenchRef.current?.querySelector<HTMLElement>('.terminal-panel')
          if (current) setTerminalHeight(current.getBoundingClientRect().height + delta)
        }}
        onReset={() => workbenchRef.current?.style.removeProperty('--terminal-track')}
      />
      <TerminalView cwd={root} />
    </main>
  )
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}
