/**
 * Pure, transport-agnostic filesystem data types shared across processes.
 * These describe *data* (what a stat looks like); the behavioral `ProjectHost`
 * interface that produces them lives main-side. No `node:*` types here so the
 * module stays importable by the renderer.
 */

import type { HostPath } from './host-path'

export type FileType = 'file' | 'dir' | 'symlink' | 'other'

export interface DirEntry {
  readonly name: string
  readonly type: FileType
}

export interface Stat {
  readonly type: FileType
  readonly size: number
  readonly mtimeMs: number
  /** POSIX mode bits. */
  readonly mode: number
}

export type WatchEventType = 'add' | 'change' | 'unlink' | 'addDir' | 'unlinkDir'

export interface WatchEvent {
  readonly type: WatchEventType
  readonly path: HostPath
}

export interface ExecResult {
  /** Exit code, or null if the process was terminated by a signal. */
  readonly code: number | null
  /** Terminating signal name, or null. */
  readonly signal: string | null
  readonly stdout: string
  readonly stderr: string
}
