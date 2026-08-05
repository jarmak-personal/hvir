import {
  unwrapOperation,
  type HostPath,
  type ProjectFileOperationProgress,
  type ProjectFileOperationResult,
} from '../../../shared'
import { useProjectFileOperation } from './use-project-file-operation'

export interface ExternalFileCopyController {
  readonly pending: boolean
  readonly progress?: ProjectFileOperationProgress
  copyClipboard(destinationDirectory: HostPath): void
  copyDropped(files: readonly File[], destinationDirectory: HostPath): void
  cancel(): void
}

export function useExternalFileCopy(options: {
  readonly root: HostPath
  readonly onStart: () => void
  readonly onComplete: (result: ProjectFileOperationResult | undefined) => void
  readonly onError: (message: string) => void
}): ExternalFileCopyController {
  const operation = useProjectFileOperation(options)
  const copy = (
    destinationDirectory: HostPath,
    acquire: () => ReturnType<typeof window.hvir.externalFiles.acquireDropped>,
  ): void => {
    operation.start(
      async () => {
        const grantResult = unwrapOperation(await acquire())
        if (grantResult.outcome === 'unsupported') throw new Error(grantResult.reason)
        return window.hvir.invoke('fs:copy-external', {
          workspaceRoot: options.root,
          destinationDirectory,
          grantId: grantResult.grant.grantId,
          grantGeneration: grantResult.grant.generation,
        })
      },
      'copying',
      'The copy could not start',
    )
  }
  return {
    pending: operation.pending,
    progress: operation.progress,
    copyClipboard: (destinationDirectory) =>
      copy(destinationDirectory, () =>
        window.hvir.invoke('fs:acquire-clipboard-files', undefined),
      ),
    copyDropped: (files, destinationDirectory) =>
      copy(destinationDirectory, () => window.hvir.externalFiles.acquireDropped(files)),
    cancel: () => operation.cancel(),
  }
}
