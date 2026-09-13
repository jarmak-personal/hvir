import type { HostPath } from '../../shared/host-path'
import type { ProjectFileMode } from './project-host'

/** Transport fingerprints; these never establish application approval or ownership. */
export interface ManagedDirectoryFile {
  readonly entry: string
  readonly mode: ProjectFileMode
  readonly size: number
  readonly sha256: string
}

export interface ManagedDirectoryTree {
  readonly files: readonly ManagedDirectoryFile[]
}

/** A preview binds even an absent target to its actual workspace and ancestors. */
export interface ManagedDirectoryLocation {
  readonly root: HostPath
  readonly rootDevice: string
  readonly rootInode: string
  readonly ancestors: ManagedDirectoryReceipt['ancestors']
  readonly missingParents: readonly string[]
}

/** Exact created directory identity, represented without JavaScript integer truncation. */
export interface ManagedDirectoryReceipt {
  readonly root: HostPath
  readonly entry: string
  readonly device: string
  readonly inode: string
  readonly rootDevice: string
  readonly rootInode: string
  readonly ancestors: readonly {
    readonly entry: string
    readonly device: string
    readonly inode: string
  }[]
  readonly tree: ManagedDirectoryTree
}

export type ManagedDirectoryInspection =
  | { readonly status: 'absent'; readonly location: ManagedDirectoryLocation }
  | { readonly status: 'different' }
  | { readonly status: 'exact'; readonly receipt: ManagedDirectoryReceipt }

export interface ManagedDirectoryPort {
  /** One bounded command for active-workspace observation, without process fanout. */
  inspectMany(
    root: HostPath,
    entries: readonly { readonly entry: string; readonly tree: ManagedDirectoryTree }[],
    signal: AbortSignal,
  ): Promise<readonly ManagedDirectoryInspection[]>
  inspect(
    root: HostPath,
    entry: string,
    tree: ManagedDirectoryTree,
    signal: AbortSignal,
  ): Promise<ManagedDirectoryInspection>
  stage(
    root: HostPath,
    entry: string,
    tree: ManagedDirectoryTree,
    bytes: ReadonlyMap<string, Uint8Array>,
    location: ManagedDirectoryLocation,
    signal: AbortSignal,
  ): Promise<ManagedDirectoryReceipt>
  commit(
    operation:
      | {
          readonly action: 'add'
          readonly candidate: ManagedDirectoryReceipt
          readonly target: string
        }
      | {
          readonly action: 'update'
          readonly candidate: ManagedDirectoryReceipt
          readonly before: ManagedDirectoryReceipt
        }
      | {
          readonly action: 'remove'
          readonly before: ManagedDirectoryReceipt
          readonly quarantine: string
        },
    options: { readonly signal: AbortSignal; readonly onSubmitted: () => void },
  ): Promise<{
    readonly status: 'completed' | 'not-applied' | 'uncertain'
    readonly published?: ManagedDirectoryReceipt
    readonly displaced?: ManagedDirectoryReceipt
  }>
  /** Deletes only this exact identity and complete tree; changed objects are retained. */
  cleanup(receipt: ManagedDirectoryReceipt, signal: AbortSignal): Promise<boolean>
}
