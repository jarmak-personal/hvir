import { useEffect, useState, type ReactElement } from 'react'

import type { HostPath, ReadFileResponse } from '../../shared'
import { TerminalView } from './terminal/TerminalView'
import { FileTree } from './tree/FileTree'
import { FileViewer } from './viewer/FileViewer'

export function App(): ReactElement {
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

  if (rootError) return <div className="startup-error">{rootError}</div>
  if (!root) return <div className="startup-loading">Starting hvir…</div>

  return (
    <main className="workbench">
      <FileTree
        root={root}
        refreshVersion={watchVersion}
        selected={selected}
        onSelect={openFile}
      />
      <FileViewer file={file} loading={fileLoading} error={fileError} />
      <TerminalView cwd={root} />
    </main>
  )
}
