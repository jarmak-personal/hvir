import { useWorkspaceDirectoryReveal } from './use-workspace-directory-reveal'
import { useCallback, useEffect, useRef } from 'react'

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
    const external = !containsHostPath(root, target.path)
    const generation = (this.generation += 1)
    // Opening first lets the viewer show missing/unreadable document errors.
    if (external) {
      this.ports.openFile(target.path, targetPosition(target))
      return
    }
    const resolveEntry = this.ports.resolveEntry
    let entry: ResolveEntryResponse
    try {
      entry = await resolveEntry(target.path)
    } catch {
      if (generation === this.generation && sameOptionalPath(root, this.root))
        this.ports.openFile(target.path, targetPosition(target))
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
    else {
      this.ports.openFile(target.path, targetPosition(target))
    }
  }
}

interface UseTerminalPathActivationOptions {
  readonly root?: HostPath
  readonly selectedFile?: HostPath
  readonly openFile: (
    path: HostPath,
    pinned: true,
    context: 'file-tree',
    diffBase: 'head',
    diffRevision: undefined,
    position?: Omit<ViewerNavigationPosition, 'serial'>,
  ) => void
  readonly revealDirectory: () => void
}

export function useTerminalPathActivation({
  root,
  selectedFile,
  openFile,
  revealDirectory,
}: UseTerminalPathActivationOptions): {
  readonly activate: (target: ResolvedTerminalFileTarget) => void
  readonly revealRequest?: { readonly path: HostPath; readonly token: number }
  readonly revealDirectory: (path: HostPath) => void
} {
  const mounted = useRef(false)
  const callbacks = useRef({ openFile, revealDirectory, selectedFile })
  const directory = useWorkspaceDirectoryReveal(root, selectedFile, revealDirectory)
  callbacks.current = { openFile, revealDirectory, selectedFile }
  const ports: TerminalPathActivationPorts = {
    resolveEntry,
    openFile: (path, position) => {
      if (!mounted.current) return
      directory.clear()
      callbacks.current.openFile(path, true, 'file-tree', 'head', undefined, position)
    },
    revealDirectory: (path) => {
      if (!mounted.current || !root) return
      directory.reveal(path)
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
  return { activate, revealRequest: directory.request, revealDirectory: directory.reveal }
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
