/**
 * Typed message protocol for main <-> utility-process communication.
 *
 * Every worker speaks the same request/response envelope, correlated by a
 * numeric id so the {@link worker-host} can match replies to requests. Each
 * worker declares its own request/response map (see `EchoProtocol`).
 */

import type { HostPath } from './host-path'
import type { GitDiffRequest, GitDiffResponse } from './viewer-types'

export interface WorkerRequest<T = unknown> {
  readonly id: number
  readonly type: string
  readonly payload: T
}

export type WorkerResponse<T = unknown> =
  | { readonly id: number; readonly ok: true; readonly result: T }
  | { readonly id: number; readonly ok: false; readonly error: string }

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

export interface GitWorkerPayload extends GitDiffRequest {
  /** Project confinement boundary, independently revalidated by the worker. */
  readonly root: HostPath
}

export interface GitWorkerProtocol {
  readonly [GIT_DIFF_INPUTS_TYPE]: WorkerOperation<GitWorkerPayload, GitDiffResponse>
}
