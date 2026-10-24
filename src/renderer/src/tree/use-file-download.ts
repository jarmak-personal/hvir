import { useCallback } from 'react'
import { type HostPath, type ProjectFileOperationResult } from '../../../shared'
import { copyFeedback, type FileActionFeedback } from './file-operation-feedback'
import { useProjectFileOperation } from './use-project-file-operation'

export function useFileDownload(options: {
  readonly root: HostPath
  readonly onStart: () => void
  readonly onFeedback: (feedback: FileActionFeedback) => void
}) {
  const { onFeedback } = options
  const complete = useCallback(
    (result: ProjectFileOperationResult | undefined) => {
      onFeedback(copyFeedback(result, 'download'))
    },
    [onFeedback],
  )
  const error = useCallback(
    (message: string) => onFeedback({ kind: 'error', message }),
    [onFeedback],
  )
  const operation = useProjectFileOperation({
    root: options.root,
    onStart: options.onStart,
    onComplete: complete,
    onError: error,
  })
  return {
    ...operation,
    download(source: HostPath) {
      operation.start(
        () =>
          window.hvir.invoke('fs:download-entry', {
            workspaceRoot: options.root,
            source,
          }),
        'downloading',
        'The download could not start',
      )
    },
  }
}
