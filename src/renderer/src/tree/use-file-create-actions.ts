import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent } from 'react'

import {
  hostPath,
  hostPathEquals,
  unwrapOperation,
  type FileOpenContext,
  type FileType,
  type HostPath,
  type ProjectFileCreateKind,
  type ProjectFileOperationProgress,
  type ProjectFileOperationResult,
} from '../../../shared'
import { copyHostPath, PATH_COPY_LABELS, type PathCopyKind } from '../path-copy/path-copy'
import type {
  DirectoryTreeEntryActions,
  DirectoryTreeRevealRequest,
} from './DirectoryTree'
import { canOrganizeAction, fileActionDestination } from './file-action-destination'
import {
  copyFeedback,
  deletionFeedback,
  organizationFeedback,
  projectFileResultHasEffect,
} from './file-operation-feedback'
import { projectFileEntryNameError } from './project-file-entry-name'
import { useExternalFileCopy } from './use-external-file-copy'
import {
  useFileOrganizationActions,
  type FileOrganizationAction,
  type FileOrganizationActionsController,
} from './use-file-organization-actions'
import {
  useFileDeletionActions,
  type FileDeletionActionsController,
} from './use-file-deletion-actions'
import type { ViewerPathRemovalCapability } from '../viewer/viewer-path-removal'

export { fileActionDestination } from './file-action-destination'
export { projectFileEntryNameError } from './project-file-entry-name'

export interface FileActionMenuRequest {
  readonly id: number
  readonly target: HostPath
  readonly targetType: FileType
  readonly label: string
  readonly x: number
  readonly y: number
  readonly focusMenu: boolean
  readonly returnFocus?: HTMLElement
}

export interface FileCreateDialogRequest {
  readonly id: number
  readonly workspaceRoot: HostPath
  readonly destinationDirectory: HostPath
  readonly kind: ProjectFileCreateKind
}

export interface FileActionFeedback {
  readonly kind: 'success' | 'error'
  readonly message: string
  readonly details?: readonly string[]
}

export interface FileCreateActionsController {
  readonly entryActions: DirectoryTreeEntryActions
  readonly menu?: FileActionMenuRequest
  readonly dialog?: FileCreateDialogRequest
  readonly dialogError?: string
  readonly pending: boolean
  readonly feedback?: FileActionFeedback
  readonly selectedDirectory?: HostPath
  readonly revealRequest?: DirectoryTreeRevealRequest
  readonly refreshVersion: number
  readonly copyProgress?: ProjectFileOperationProgress
  readonly organization: FileOrganizationActionsController
  readonly deletion: FileDeletionActionsController
  canOrganizeMenu(action: FileOrganizationAction): boolean
  openRootFromPointer(event: MouseEvent<HTMLElement>): void
  beginCreate(kind: ProjectFileCreateKind): void
  beginOrganization(action: FileOrganizationAction): void
  beginDeletion(): void
  submitCreate(name: string): void
  copyPath(kind: PathCopyKind): void
  pasteFiles(target: HostPath, targetType: FileType): void
  pasteFilesFromMenu(): void
  dropFiles(files: readonly File[], target: HostPath, targetType: FileType): void
  cancelCopy(): void
  dismissFeedback(): void
  dismissMenu(restoreFocus?: boolean): void
  dismissDialog(): void
  clearCreatedSelection(): void
}

export function useFileCreateActions(
  options: {
    readonly root: HostPath
    readonly onCreatedFile: (
      path: HostPath,
      pinned: boolean,
      context?: FileOpenContext,
    ) => void
    readonly canRebindPath: (source: HostPath, destination: HostPath) => boolean
    readonly onRebindPath: (source: HostPath, destination: HostPath) => boolean
    readonly onWorkspaceContentChanged: () => void
  } & ViewerPathRemovalCapability,
): FileCreateActionsController {
  const { root, onCreatedFile, onWorkspaceContentChanged } = options
  const [menu, setMenu] = useState<FileActionMenuRequest>()
  const [dialog, setDialog] = useState<FileCreateDialogRequest>()
  const [dialogError, setDialogError] = useState<string>()
  const [pending, setPending] = useState(false)
  const [feedback, setFeedback] = useState<FileActionFeedback>()
  const [selectedDirectory, setSelectedDirectory] = useState<HostPath>()
  const [revealRequest, setRevealRequest] = useState<DirectoryTreeRevealRequest>()
  const [refreshVersion, setRefreshVersion] = useState(0)
  const nextRequestId = useRef(0)
  const nextRevealToken = useRef(0)
  const activeDialogId = useRef<number | undefined>(undefined)
  const alive = useRef(true)
  const ownerKey = `${root.hostId}\0${root.path}`
  const latestOwnerKey = useRef(ownerKey)
  latestOwnerKey.current = ownerKey

  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
    }
  }, [])
  useEffect(() => {
    activeDialogId.current = undefined
    setMenu(undefined)
    setDialog(undefined)
    setDialogError(undefined)
    setPending(false)
    setFeedback(undefined)
    setSelectedDirectory(undefined)
    setRevealRequest(undefined)
  }, [ownerKey])
  useEffect(() => {
    if (!feedback || feedback.kind === 'error' || feedback.details?.length) return
    const timeout = window.setTimeout(() => setFeedback(undefined), 4_000)
    return () => window.clearTimeout(timeout)
  }, [feedback])
  const handleCopyStart = useCallback(() => {
    setMenu(undefined)
    setFeedback(undefined)
  }, [])
  const handleCopyComplete = useCallback(
    (result: ProjectFileOperationResult | undefined) => {
      setRefreshVersion((value) => value + 1)
      setFeedback(copyFeedback(result))
      if (projectFileResultHasEffect(result)) onWorkspaceContentChanged()
    },
    [onWorkspaceContentChanged],
  )
  const handleCopyError = useCallback((message: string) => {
    setFeedback({ kind: 'error', message })
  }, [])
  const externalCopy = useExternalFileCopy({
    root,
    onStart: handleCopyStart,
    onComplete: handleCopyComplete,
    onError: handleCopyError,
  })
  const handleOrganizationComplete = useCallback(
    (result: ProjectFileOperationResult | undefined) => {
      setRefreshVersion((value) => value + 1)
      setFeedback(organizationFeedback(result))
      if (projectFileResultHasEffect(result)) onWorkspaceContentChanged()
      const item = result?.outcome === 'completed' ? result.items[0] : undefined
      if (item?.status === 'completed') {
        setSelectedDirectory(item.destination)
        setRevealRequest({
          path: item.destination,
          token: (nextRevealToken.current += 1),
        })
      }
    },
    [onWorkspaceContentChanged],
  )
  const organization = useFileOrganizationActions({
    root,
    canRebindPath: options.canRebindPath,
    onRebindPath: options.onRebindPath,
    onStart: handleCopyStart,
    onComplete: handleOrganizationComplete,
    onError: handleCopyError,
  })
  const deletion = useFileDeletionActions({
    root,
    viewer: {
      reviewPathRemoval: options.reviewPathRemoval,
      closeCleanPath: options.closeCleanPath,
    },
    onStart: handleCopyStart,
    onComplete(result, viewerCleanup) {
      setRefreshVersion((value) => value + 1)
      setFeedback(deletionFeedback(result, viewerCleanup))
      if (projectFileResultHasEffect(result)) onWorkspaceContentChanged()
      setSelectedDirectory(undefined)
      setRevealRequest(undefined)
    },
    onError: handleCopyError,
  })
  const operationPending =
    pending || externalCopy.pending || organization.pending || deletion.pending

  const openMenu = useCallback(
    (
      target: HostPath,
      targetType: FileType,
      label: string,
      x: number,
      y: number,
      focusMenu: boolean,
      returnFocus?: HTMLElement,
    ) => {
      deletion.inspect(hostPathEquals(target, root) ? undefined : target)
      setMenu({
        id: (nextRequestId.current += 1),
        target: hostPath(target.hostId, target.path),
        targetType,
        label,
        x,
        y,
        focusMenu,
        returnFocus,
      })
    },
    [deletion, root],
  )
  const entryActions = useMemo<DirectoryTreeEntryActions>(
    () => ({
      openFromPointer(event, target, label, type) {
        event.preventDefault()
        event.stopPropagation()
        openMenu(
          target,
          type,
          label,
          event.clientX,
          event.clientY,
          false,
          focusedElement(),
        )
      },
      openFromKeyboard(event, target, label, type) {
        if (event.key !== 'ContextMenu' && !(event.shiftKey && event.key === 'F10')) {
          return false
        }
        event.preventDefault()
        event.stopPropagation()
        const bounds = event.currentTarget.getBoundingClientRect()
        openMenu(
          target,
          type,
          label,
          bounds.left + Math.min(bounds.width, 24),
          bounds.bottom,
          true,
          event.currentTarget,
        )
        return true
      },
    }),
    [openMenu],
  )

  const dismissMenu = useCallback(
    (restoreFocus = false) => {
      setMenu(undefined)
      deletion.inspect(undefined)
      if (restoreFocus) menu?.returnFocus?.focus({ preventScroll: true })
    },
    [deletion, menu],
  )
  const beginCreate = useCallback(
    (kind: ProjectFileCreateKind) => {
      if (!menu || operationPending) return
      const id = (nextRequestId.current += 1)
      activeDialogId.current = id
      setDialog({
        id,
        workspaceRoot: hostPath(root.hostId, root.path),
        destinationDirectory: fileActionDestination(root, menu.target, menu.targetType),
        kind,
      })
      setDialogError(undefined)
      setFeedback(undefined)
      setMenu(undefined)
    },
    [menu, operationPending, root],
  )

  const submitCreate = useCallback(
    (name: string) => {
      if (!dialog || operationPending) return
      const validation = projectFileEntryNameError(name)
      if (validation) {
        setDialogError(validation)
        return
      }
      const request = dialog
      const requestOwnerKey = `${request.workspaceRoot.hostId}\0${request.workspaceRoot.path}`
      const requestIsCurrent = (): boolean =>
        alive.current &&
        latestOwnerKey.current === requestOwnerKey &&
        activeDialogId.current === request.id
      setPending(true)
      setDialogError(undefined)
      void window.hvir
        .invoke('fs:create-entry', {
          workspaceRoot: request.workspaceRoot,
          destinationDirectory: request.destinationDirectory,
          name,
          kind: request.kind,
        })
        .then(unwrapOperation)
        .then(
          (result) => {
            if (!requestIsCurrent()) return
            if (result.outcome === 'busy') {
              setDialogError(result.reason)
              return
            }
            const item = result.items[0]
            if (!item || item.status !== 'completed') {
              setDialogError(item?.reason ?? 'The entry could not be created')
              return
            }
            const destination = hostPath(item.destination.hostId, item.destination.path)
            activeDialogId.current = undefined
            setDialog(undefined)
            setPending(false)
            setRefreshVersion((value) => value + 1)
            onWorkspaceContentChanged()
            setFeedback({
              kind: 'success',
              message:
                item.effect === 'created-file' ? 'File created.' : 'Folder created.',
            })
            if (item.effect === 'created-file') {
              setSelectedDirectory(undefined)
              setRevealRequest(undefined)
              onCreatedFile(destination, true, 'created-file')
            } else {
              setSelectedDirectory(destination)
              setRevealRequest({
                path: destination,
                token: (nextRevealToken.current += 1),
              })
            }
          },
          (reason: unknown) => {
            if (requestIsCurrent()) {
              setDialogError(
                reason instanceof Error
                  ? reason.message
                  : 'The entry could not be created',
              )
            }
          },
        )
        .finally(() => {
          if (requestIsCurrent()) setPending(false)
        })
    },
    [dialog, onCreatedFile, onWorkspaceContentChanged, operationPending],
  )

  const copyPath = useCallback(
    (kind: PathCopyKind) => {
      if (!menu || operationPending) return
      const requestOwnerKey = ownerKey
      const returnFocus = menu.focusMenu ? menu.returnFocus : undefined
      setPending(true)
      void copyHostPath(root, menu.target, kind, writeApplicationClipboard).then(
        () => {
          if (!alive.current || latestOwnerKey.current !== requestOwnerKey) return
          setFeedback({
            kind: 'success',
            message: `${PATH_COPY_LABELS[kind].replace('Copy ', '')} copied.`,
          })
          setMenu(undefined)
          setPending(false)
          returnFocus?.focus({ preventScroll: true })
        },
        () => {
          if (!alive.current || latestOwnerKey.current !== requestOwnerKey) return
          setFeedback({
            kind: 'error',
            message: 'Could not copy the path to the clipboard.',
          })
          setMenu(undefined)
          setPending(false)
          returnFocus?.focus({ preventScroll: true })
        },
      )
    },
    [menu, operationPending, ownerKey, root],
  )

  return {
    entryActions,
    menu,
    dialog,
    dialogError,
    pending: operationPending,
    feedback,
    organization,
    deletion,
    selectedDirectory,
    revealRequest,
    refreshVersion,
    copyProgress: externalCopy.progress ?? organization.progress ?? deletion.progress,
    canOrganizeMenu(action) {
      return canOrganizeAction(root, menu?.target, menu?.targetType, action)
    },
    openRootFromPointer(event) {
      if (event.target !== event.currentTarget) return
      event.preventDefault()
      openMenu(
        root,
        'dir',
        root.path,
        event.clientX,
        event.clientY,
        false,
        focusedElement(),
      )
    },
    beginCreate,
    beginOrganization(action) {
      if (
        !menu ||
        operationPending ||
        !canOrganizeAction(root, menu.target, menu.targetType, action)
      )
        return
      organization.begin(action, menu.target, menu.targetType)
      setMenu(undefined)
      setFeedback(undefined)
    },
    beginDeletion() {
      if (!menu || operationPending) return
      if (deletion.menu.state === 'available') {
        setMenu(undefined)
        setFeedback(undefined)
        deletion.begin()
      }
    },
    submitCreate,
    copyPath,
    pasteFiles(target, targetType) {
      externalCopy.copyClipboard(fileActionDestination(root, target, targetType))
    },
    pasteFilesFromMenu() {
      if (!menu) return
      externalCopy.copyClipboard(
        fileActionDestination(root, menu.target, menu.targetType),
      )
    },
    dropFiles(files, target, targetType) {
      externalCopy.copyDropped(files, fileActionDestination(root, target, targetType))
    },
    cancelCopy() {
      if (externalCopy.pending) externalCopy.cancel()
      else if (organization.pending) organization.cancel()
      else deletion.cancel()
    },
    dismissFeedback() {
      setFeedback(undefined)
    },
    dismissMenu,
    dismissDialog() {
      activeDialogId.current = undefined
      setDialog(undefined)
      setDialogError(undefined)
      setPending(false)
    },
    clearCreatedSelection() {
      setSelectedDirectory(undefined)
      setRevealRequest(undefined)
    },
  }
}

function writeApplicationClipboard(value: string): Promise<void> {
  return navigator.clipboard?.writeText
    ? navigator.clipboard.writeText(value)
    : Promise.reject(new Error('Clipboard writing is unavailable'))
}

function focusedElement(): HTMLElement | undefined {
  const active = document.activeElement
  return active instanceof HTMLElement ? active : undefined
}
