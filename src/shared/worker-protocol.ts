/**
 * Typed message protocol for main <-> utility-process communication.
 *
 * Every worker speaks the same request/response envelope, correlated by a
 * numeric id so the {@link worker-host} can match replies to requests. Each
 * worker declares its own request/response map (see `EchoProtocol`).
 */

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

export interface EchoPayload {
  readonly text: string
}

export interface EchoResult {
  readonly text: string
  /** PID of the utility process that handled it — proves it ran off-main. */
  readonly workerPid: number
}
