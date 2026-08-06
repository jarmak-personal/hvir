import { useCallback, useEffect, useRef, useState } from 'react'

import {
  basenameHostPath,
  containsHostPath,
  dirnameHostPath,
  hostPath,
  hostPathEquals,
  joinHostPath,
  type FileType,
  type HostPath,
  type ProjectFileOperationProgress,
  type ProjectFileOperationResult,
  type ProjectFileOrganizationRequest,
} from '../../../shared'
import { projectFileEntryNameError } from './project-file-entry-name'
import { projectFileOwnerKey } from './project-file-owner-key'
import { useProjectFileOperation } from './use-project-file-operation'

export type FileOrganizationAction = 'rename' | 'move' | 'duplicate'

export function canOrganizeAction(
  root: HostPath,
  target: HostPath | undefined,
  targetType: FileType | undefined,
  action: FileOrganizationAction,
): boolean {
  if (!target || !targetType || hostPathEquals(target, root)) return false
  return action === 'duplicate'
    ? targetType === 'file' || targetType === 'dir'
    : targetType !== 'other'
}

export interface FileOrganizationDialogRequest {
  readonly id: number
  readonly action: FileOrganizationAction
  readonly workspaceRoot: HostPath
  readonly source: HostPath
  readonly sourceType: FileType
  readonly destinationDirectory: HostPath
}

export interface FileOrganizationActionsController {
  readonly dialog?: FileOrganizationDialogRequest
  readonly dialogError?: string
  readonly pending: boolean
  readonly progress?: ProjectFileOperationProgress
  begin(action: FileOrganizationAction, source: HostPath, sourceType: FileType): void
  selectDirectory(path: HostPath): void
  submit(name: string): void
  dismiss(): void
  cancel(): void
}

export function useFileOrganizationActions(options: {
  readonly root: HostPath
  readonly canRebindPath: (source: HostPath, destination: HostPath) => boolean
  readonly onRebindPath: (source: HostPath, destination: HostPath) => boolean
  readonly onStart: () => void
  readonly onComplete: (result: ProjectFileOperationResult | undefined) => void
  readonly onError: (message: string) => void
}): FileOrganizationActionsController {
  const { root, canRebindPath, onRebindPath, onStart, onComplete, onError } = options
  const [dialog, setDialog] = useState<FileOrganizationDialogRequest>()
  const [dialogError, setDialogError] = useState<string>()
  const nextId = useRef(0)
  const activeRequest = useRef<ProjectFileOrganizationRequest | undefined>(undefined)
  const ownerKey = projectFileOwnerKey(root)
  const latestOwnerKey = useRef(ownerKey)
  latestOwnerKey.current = ownerKey
  const finish = useCallback(
    (result: ProjectFileOperationResult | undefined) => {
      const request = activeRequest.current
      activeRequest.current = undefined
      const item = result?.outcome === 'completed' ? result.items[0] : undefined
      if (
        request &&
        item?.status === 'completed' &&
        (item.effect === 'renamed-entry' || item.effect === 'moved-entry')
      ) {
        const rebound = onRebindPath(request.source, item.destination)
        if (!rebound) {
          setDialog(undefined)
          setDialogError(undefined)
          onComplete(result)
          onError(
            'The filesystem move succeeded, but source-tab identities could not be rebound because the destination now has unsaved changes. Both source and destination buffers were preserved; save or close the destination tab, then reopen the moved files from the tree.',
          )
          return
        }
      }
      setDialog(undefined)
      setDialogError(undefined)
      onComplete(result)
    },
    [onComplete, onError, onRebindPath],
  )
  const fail = useCallback(
    (message: string) => {
      activeRequest.current = undefined
      setDialogError(message)
      onError(message)
    },
    [onError],
  )
  const operation = useProjectFileOperation({
    root,
    onStart,
    onComplete: finish,
    onError: fail,
  })

  useEffect(() => {
    activeRequest.current = undefined
    setDialog(undefined)
    setDialogError(undefined)
  }, [ownerKey])

  return {
    dialog,
    dialogError,
    pending: operation.pending,
    progress: operation.progress,
    begin(action, source, sourceType) {
      if (operation.pending || hostPathEquals(source, root)) return
      setDialog({
        id: (nextId.current += 1),
        action,
        workspaceRoot: hostPath(root.hostId, root.path),
        source: hostPath(source.hostId, source.path),
        sourceType,
        destinationDirectory: hostPath(root.hostId, root.path),
      })
      setDialogError(undefined)
    },
    selectDirectory(path) {
      if (!dialog || operation.pending || !containsHostPath(root, path)) return
      setDialog({ ...dialog, destinationDirectory: hostPath(path.hostId, path.path) })
      setDialogError(undefined)
    },
    submit(name) {
      if (!dialog || operation.pending) return
      const request = organizationRequest(dialog, name)
      if (!request) {
        setDialogError(projectFileEntryNameError(name) ?? 'Select a destination.')
        return
      }
      const destination = requestDestination(request)
      if (
        dialog.sourceType === 'dir' &&
        request.action !== 'rename' &&
        containsHostPath(dialog.source, request.destinationDirectory)
      ) {
        setDialogError('Choose a directory outside the source folder.')
        return
      }
      if (request.action !== 'duplicate' && !canRebindPath(request.source, destination)) {
        setDialogError('A destination tab has unsaved changes; close or save it first.')
        return
      }
      setDialogError(undefined)
      const accepted = operation.start(
        () => window.hvir.invoke('fs:organize-entry', request),
        request.action === 'rename'
          ? 'renaming'
          : request.action === 'move'
            ? 'moving'
            : 'duplicating',
        `The ${request.action} operation could not start`,
      )
      if (accepted) activeRequest.current = request
    },
    dismiss() {
      if (operation.pending) return
      activeRequest.current = undefined
      setDialog(undefined)
      setDialogError(undefined)
    },
    cancel: () => operation.cancel(),
  }
}

function organizationRequest(
  dialog: FileOrganizationDialogRequest,
  name: string,
): ProjectFileOrganizationRequest | undefined {
  if (dialog.action === 'rename') {
    return projectFileEntryNameError(name)
      ? undefined
      : {
          action: 'rename',
          workspaceRoot: dialog.workspaceRoot,
          source: dialog.source,
          name,
        }
  }
  if (dialog.action === 'move') {
    return {
      action: 'move',
      workspaceRoot: dialog.workspaceRoot,
      source: dialog.source,
      destinationDirectory: dialog.destinationDirectory,
    }
  }
  return projectFileEntryNameError(name)
    ? undefined
    : {
        action: 'duplicate',
        workspaceRoot: dialog.workspaceRoot,
        source: dialog.source,
        destinationDirectory: dialog.destinationDirectory,
        name,
      }
}

function requestDestination(request: ProjectFileOrganizationRequest): HostPath {
  return request.action === 'rename'
    ? joinHostPath(dirnameHostPath(request.source), request.name)
    : joinHostPath(
        request.destinationDirectory,
        request.action === 'move' ? basenameHostPath(request.source) : request.name,
      )
}
