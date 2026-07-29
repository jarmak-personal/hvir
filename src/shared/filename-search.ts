import type { HostPath } from './host-path'

export const FILENAME_SEARCH_RESULT_LIMIT = 100

export interface FilenameSearchRequest {
  readonly root: HostPath
  readonly query: string
  readonly includeIgnored: boolean
  readonly refreshVersion: number
  /** Renderer-generation monotonic token used to reject out-of-order IPC completion. */
  readonly requestId: number
}

export interface FilenameSearchResult {
  readonly path: HostPath
  readonly name: string
  /** POSIX path relative to the active workspace, or `.` for a root file. */
  readonly parentPath: string
}

export interface FilenameSearchResponse {
  readonly results: readonly FilenameSearchResult[]
  readonly traversalTruncated: boolean
  readonly resultsTruncated: boolean
}
