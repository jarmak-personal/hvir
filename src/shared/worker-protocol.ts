/**
 * Typed message protocol for main <-> utility-process communication.
 *
 * Every worker speaks the same request/response envelope, correlated by a
 * numeric id so the {@link worker-host} can match replies to requests. Each
 * worker declares its own request/response map (see `EchoProtocol`).
 */

import type { HostPath } from './host-path'
import type { ExecResult } from './fs-types'
import type { GitDiffRequest, GitDiffResponse } from './viewer-types'
import type {
  GitBlameRun,
  GitBlameRequest,
  GitChanges,
  GitChangesRequest,
  GitHistoryPage,
  GitHistoryRequest,
  GitCommitDetail,
  GitCommitDetailRequest,
} from './git-types'

export interface WorkerRequest<T = unknown> {
  readonly id: number
  readonly type: string
  readonly payload: T
}

export type WorkerResponse<T = unknown> =
  | { readonly id: number; readonly ok: true; readonly result: T }
  | { readonly id: number; readonly ok: false; readonly error: string }

export type WorkerHostCallInput =
  | {
      readonly hostId: string
      readonly operation: 'exec'
      readonly command: string
      readonly args: readonly string[]
      readonly cwd?: HostPath
      readonly input?: string
      readonly maxBuffer?: number
    }
  | {
      readonly hostId: string
      readonly operation: 'readTextFile'
      readonly path: HostPath
    }

export type WorkerHostCall = WorkerHostCallInput & {
  readonly kind: 'host-call'
  readonly callId: number
}

export type WorkerHostResult =
  | {
      readonly kind: 'host-result'
      readonly callId: number
      readonly ok: true
      readonly result: ExecResult | string
    }
  | {
      readonly kind: 'host-result'
      readonly callId: number
      readonly ok: false
      readonly error: string
    }

// --- Echo worker (the Phase-1 utility-process proof) ----------------------

export const ECHO_REQUEST_TYPE = 'echo' as const

/** One request/response operation in a worker protocol map. */
export interface WorkerOperation<Request = unknown, Response = unknown> {
  readonly request: Request
  readonly response: Response
}

export interface EchoPayload {
  readonly text: string
}

export interface EchoResult {
  readonly text: string
  /** PID of the utility process that handled it — proves it ran off-main. */
  readonly workerPid: number
}

/** Compile-time contract spoken by the Phase 1 echo worker. */
export interface EchoWorkerProtocol {
  readonly [ECHO_REQUEST_TYPE]: WorkerOperation<EchoPayload, EchoResult>
}

// --- Git worker (ADR-005/010) --------------------------------------------

export const GIT_DIFF_INPUTS_TYPE = 'git:diff-inputs' as const
export const GIT_CHANGES_TYPE = 'git:changes' as const
export const GIT_HISTORY_TYPE = 'git:history' as const
export const GIT_BLAME_TYPE = 'git:blame' as const
export const GIT_COMMIT_DETAIL_TYPE = 'git:commit-detail' as const

export interface GitWorkerPayload extends GitDiffRequest {
  /** Project confinement boundary, independently revalidated by the worker. */
  readonly root: HostPath
}

export interface GitWorkerProtocol {
  readonly [GIT_DIFF_INPUTS_TYPE]: WorkerOperation<GitWorkerPayload, GitDiffResponse>
  readonly [GIT_CHANGES_TYPE]: WorkerOperation<
    GitChangesRequest & { readonly root: HostPath },
    GitChanges
  >
  readonly [GIT_HISTORY_TYPE]: WorkerOperation<GitHistoryRequest, GitHistoryPage>
  readonly [GIT_COMMIT_DETAIL_TYPE]: WorkerOperation<
    GitCommitDetailRequest,
    GitCommitDetail
  >
  readonly [GIT_BLAME_TYPE]: WorkerOperation<
    GitBlameRequest & { readonly root: HostPath },
    readonly GitBlameRun[]
  >
}
