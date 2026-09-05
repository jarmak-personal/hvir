import { isTemporaryDocument } from '../../../shared/temporary-document'
import { useCallback, useEffect, useRef, useState } from 'react'

import {
  containsHostPath,
  hostPathEquals,
  unwrapOperation,
  type HvirApi,
  type HostPath,
  type ResolveEntryResponse,
} from '../../../shared'
import type { ResolvedTerminalFileTarget } from '../terminal/terminal-file-link'
import type { ViewerNavigationPosition } from '../viewer/tab-state'

export interface TerminalPathActivationPorts {
  readonly resolveEntry: (path: HostPath) => Promise<ResolveEntryResponse>
  readonly openFile: (
    path: HostPath,
    position?: Omit<ViewerNavigationPosition, 'serial'>,
  ) => void
  readonly revealDirectory: (path: HostPath) => void
}

/**
 * Routes an already-authorized terminal path without giving the terminal or
 * composition root filesystem policy. Workspace generations reject late
 * classification after navigation.
 */
export class TerminalPathActivationCoordinator {
  private root: HostPath | undefined
  private generation = 0

  constructor(private ports: TerminalPathActivationPorts) {}

  update(root: HostPath | undefined, ports: TerminalPathActivationPorts): void {
    if (!sameOptionalPath(this.root, root)) this.generation += 1
    this.root = root
    this.ports = ports
  }

  invalidate(): void {
    this.generation += 1
  }

  async activate(target: ResolvedTerminalFileTarget): Promise<void> {
    const root = this.root
    if (!root || target.path.hostId !== root.hostId) return
    const temporary =
      !containsHostPath(root, target.path) && isTemporaryDocument(target.path)
    if (!containsHostPath(root, target.path) && !temporary) return
    const generation = (this.generation += 1)
    // Opening first lets the viewer show missing/unreadable document errors.
    if (temporary) {
      this.ports.openFile(target.path, targetPosition(target))
      return
    }
    const resolveEntry = this.ports.resolveEntry
    let entry: ResolveEntryResponse
    try {
      entry = await resolveEntry(target.path)
    } catch {
      return
    }
    if (
      generation !== this.generation ||
      !sameOptionalPath(root, this.root) ||
      !hostPathEquals(entry.path, target.path)
    ) {
      return
    }
    if (entry.type === 'dir') this.ports.revealDirectory(entry.path)
    else if (entry.type === 'file') {
      this.ports.openFile(target.path, targetPosition(target))
    }
  }
}

interface UseTerminalPathActivationOptions {
  readonly root?: HostPath
  readonly selectedFile?: HostPath
  readonly openFile: (
    path: HostPath,
    position?: Omit<ViewerNavigationPosition, 'serial'>,
  ) => void
  readonly revealDirectory: () => void
}

interface DirectoryRevealState {
  readonly root: HostPath
  readonly selectedFile?: HostPath
  readonly request: TerminalDirectoryRevealRequest
}

interface TerminalDirectoryRevealRequest {
  readonly path: HostPath
  readonly token: number
}

export function useTerminalPathActivation({
  root,
  selectedFile,
  openFile,
  revealDirectory,
}: UseTerminalPathActivationOptions): {
  readonly activate: (target: ResolvedTerminalFileTarget) => void
  readonly revealRequest?: TerminalDirectoryRevealRequest
} {
  const mounted = useRef(false)
  const revealToken = useRef(0)
  const callbacks = useRef({ openFile, revealDirectory, selectedFile })
  const [directoryReveal, setDirectoryReveal] = useState<DirectoryRevealState>()
  callbacks.current = { openFile, revealDirectory, selectedFile }
  const ports: TerminalPathActivationPorts = {
    resolveEntry,
    openFile: (path, position) => {
      if (!mounted.current) return
      setDirectoryReveal(undefined)
      callbacks.current.openFile(path, position)
    },
    revealDirectory: (path) => {
      if (!mounted.current || !root) return
      setDirectoryReveal({
        root,
        selectedFile: callbacks.current.selectedFile,
        request: { path, token: (revealToken.current += 1) },
      })
      callbacks.current.revealDirectory()
    },
  }
  const coordinator = useRef<TerminalPathActivationCoordinator | undefined>(undefined)
  coordinator.current ??= new TerminalPathActivationCoordinator(ports)
  coordinator.current.update(root, ports)

  useEffect(() => {
    mounted.current = true
    const active = coordinator.current
    return () => {
      mounted.current = false
      active?.invalidate()
    }
  }, [])

  const activate = useCallback((target: ResolvedTerminalFileTarget): void => {
    void coordinator.current?.activate(target)
  }, [])
  const revealRequest =
    directoryReveal &&
    root &&
    hostPathEquals(directoryReveal.root, root) &&
    sameOptionalPath(directoryReveal.selectedFile, selectedFile)
      ? directoryReveal.request
      : undefined
  return { activate, revealRequest }
}

async function resolveEntry(path: HostPath): Promise<ResolveEntryResponse> {
  const api = (globalThis as unknown as { readonly window: { readonly hvir: HvirApi } })
    .window.hvir
  return api.invoke('fs:resolve-entry', { path }).then(unwrapOperation)
}

function targetPosition(
  target: ResolvedTerminalFileTarget,
): Omit<ViewerNavigationPosition, 'serial'> | undefined {
  return target.line === undefined
    ? undefined
    : { line: target.line, column: target.column }
}

function sameOptionalPath(
  left: HostPath | undefined,
  right: HostPath | undefined,
): boolean {
  if (!left || !right) return left === right
  return hostPathEquals(left, right)
}
