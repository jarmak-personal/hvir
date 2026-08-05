import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent } from 'react'

import {
  dirnameHostPath,
  hostPath,
  isProjectFileEntryName,
  unwrapOperation,
  type FileOpenContext,
  type FileType,
  type HostPath,
  type ProjectFileCreateKind,
} from '../../../shared'
import { copyHostPath, PATH_COPY_LABELS, type PathCopyKind } from '../path-copy/path-copy'
import type {
  DirectoryTreeEntryActions,
  DirectoryTreeRevealRequest,
} from './DirectoryTree'

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
  openRootFromPointer(event: MouseEvent<HTMLElement>): void
  beginCreate(kind: ProjectFileCreateKind): void
  submitCreate(name: string): void
  copyPath(kind: PathCopyKind): void
  dismissMenu(restoreFocus?: boolean): void
  dismissDialog(): void
  clearCreatedSelection(): void
}

export function useFileCreateActions(options: {
  readonly root: HostPath
  readonly onCreatedFile: (
    path: HostPath,
    pinned: boolean,
    context?: FileOpenContext,
  ) => void
}): FileCreateActionsController {
  const { root, onCreatedFile } = options
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
  const ownerKey = pathKey(root)
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
    if (!feedback) return
    const timeout = window.setTimeout(() => setFeedback(undefined), 4_000)
    return () => window.clearTimeout(timeout)
  }, [feedback])

  const openMenu = useCallback(
    (
      target: HostPath,
      targetType: FileType,
      label: string,
      x: number,
      y: number,
      focusMenu: boolean,
      returnFocus?: HTMLElement,
    ) =>
      setMenu({
        id: (nextRequestId.current += 1),
        target: hostPath(target.hostId, target.path),
        targetType,
        label,
        x,
        y,
        focusMenu,
        returnFocus,
      }),
    [],
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
      if (restoreFocus) menu?.returnFocus?.focus({ preventScroll: true })
    },
    [menu],
  )
  const beginCreate = useCallback(
    (kind: ProjectFileCreateKind) => {
      if (!menu || pending) return
      const id = (nextRequestId.current += 1)
      activeDialogId.current = id
      setDialog({
        id,
        workspaceRoot: hostPath(root.hostId, root.path),
        destinationDirectory: fileActionDestination(root, menu.target, menu.targetType),
        kind,
      })
      setDialogError(undefined)
      setMenu(undefined)
    },
    [menu, pending, root],
  )

  const submitCreate = useCallback(
    (name: string) => {
      if (!dialog || pending) return
      const validation = projectFileEntryNameError(name)
      if (validation) {
        setDialogError(validation)
        return
      }
      const request = dialog
      const requestOwnerKey = pathKey(request.workspaceRoot)
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
              setDialogError(errorMessage(reason))
            }
          },
        )
        .finally(() => {
          if (requestIsCurrent()) setPending(false)
        })
    },
    [dialog, onCreatedFile, pending],
  )

  const copyPath = useCallback(
    (kind: PathCopyKind) => {
      if (!menu || pending) return
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
    [menu, ownerKey, pending, root],
  )

  return {
    entryActions,
    menu,
    dialog,
    dialogError,
    pending,
    feedback,
    selectedDirectory,
    revealRequest,
    refreshVersion,
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
    submitCreate,
    copyPath,
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

export function fileActionDestination(
  root: HostPath,
  target: HostPath,
  targetType: FileType,
): HostPath {
  if (target.hostId !== root.hostId) return root
  return targetType === 'dir'
    ? hostPath(target.hostId, target.path)
    : dirnameHostPath(target)
}

export function projectFileEntryNameError(name: string): string | undefined {
  if (isProjectFileEntryName(name)) return undefined
  if (name.length === 0) return 'Enter one file or folder name.'
  return 'Use one name without “.”, “..”, NUL, “/”, or “\\”.'
}

function writeApplicationClipboard(value: string): Promise<void> {
  return navigator.clipboard?.writeText
    ? navigator.clipboard.writeText(value)
    : Promise.reject(new Error('Clipboard writing is unavailable'))
}

function focusedElement(): HTMLElement | undefined {
  return document.activeElement instanceof HTMLElement
    ? document.activeElement
    : undefined
}

function pathKey(path: HostPath): string {
  return `${path.hostId}\0${path.path}`
}

function errorMessage(reason: unknown): string {
  return reason instanceof Error ? reason.message : 'The entry could not be created'
}
