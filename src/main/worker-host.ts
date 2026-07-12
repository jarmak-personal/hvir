/**
 * Utility-process harness.
 *
 * Launches a compiled `src/workers/*` module as an Electron utility process and
 * exposes a typed request/response client over the {@link WorkerRequest} /
 * {@link WorkerResponse} envelope. This is the seam by which heavy work (git
 * walks, tokenizing, large reads) runs off the render thread — "nothing blocks
 * the paint" (design §3.2). Phase 1 proves it with the echo worker.
 */

import { join } from 'node:path'
import { utilityProcess, type UtilityProcess } from 'electron'

import type {
  ExecResult,
  WorkerHostCall,
  WorkerHostResult,
  WorkerOperation,
  WorkerRequest,
  WorkerResponse,
} from '../shared'

type ProtocolShape<P> = { readonly [K in keyof P]: WorkerOperation }

export interface WorkerClient<P extends ProtocolShape<P>> {
  /** Send a request declared by this worker's protocol map. */
  request<K extends keyof P & string>(
    type: K,
    payload: P[K]['request'],
  ): Promise<P[K]['response']>
  /** PID of the utility process, once spawned. */
  readonly pid: number | undefined
  dispose(): void
}

interface Pending {
  resolve(value: unknown): void
  reject(reason: Error): void
}

/** Absolute path to a built worker entry (they sit beside the main bundle). */
export function workerPath(entryFile: string): string {
  return join(__dirname, entryFile)
}

export function createWorkerClient<P extends ProtocolShape<P>>(
  entryPath: string,
  serviceName?: string,
  onHostCall?: (call: WorkerHostCall) => Promise<ExecResult | string>,
): WorkerClient<P> {
  const proc: UtilityProcess = utilityProcess.fork(entryPath, [], {
    serviceName: serviceName ?? 'hvir-worker',
    stdio: 'inherit',
  })

  const pending = new Map<number, Pending>()
  let nextId = 1
  let disposed = false
  let spawnFailure: Error | undefined

  // Gate sends until the child has spawned or failed. Resolving on failure
  // avoids an unhandled rejected promise when a worker dies before any request.
  let markReady: () => void = () => undefined
  const ready = new Promise<void>((resolve) => {
    markReady = resolve
  })

  proc.once('spawn', markReady)

  proc.on('message', (msg: WorkerResponse | WorkerHostCall) => {
    if (isWorkerHostCall(msg)) {
      if (!onHostCall) {
        const response: WorkerHostResult = {
          kind: 'host-result',
          callId: msg.callId,
          ok: false,
          error: 'worker host calls are disabled',
        }
        proc.postMessage(response)
        return
      }
      void onHostCall(msg).then(
        (result) =>
          proc.postMessage({
            kind: 'host-result',
            callId: msg.callId,
            ok: true,
            result,
          } satisfies WorkerHostResult),
        (error: unknown) =>
          proc.postMessage({
            kind: 'host-result',
            callId: msg.callId,
            ok: false,
            error: error instanceof Error ? error.message : String(error),
          } satisfies WorkerHostResult),
      )
      return
    }
    const p = pending.get(msg.id)
    if (!p) return
    pending.delete(msg.id)
    if (msg.ok) p.resolve(msg.result)
    else p.reject(new Error(msg.error))
  })

  proc.on('error', (type, location, report) => {
    const cause = new Error(`worker ${type} at ${location}${report ? `: ${report}` : ''}`)
    spawnFailure = cause
    markReady()
    for (const p of pending.values()) p.reject(cause)
    pending.clear()
  })

  proc.on('exit', (code) => {
    const err = new Error(`worker exited (code ${code})`)
    spawnFailure ??= err
    markReady()
    for (const p of pending.values()) p.reject(err)
    pending.clear()
  })

  return {
    get pid() {
      return proc.pid
    },
    async request<K extends keyof P & string>(
      type: K,
      payload: P[K]['request'],
    ): Promise<P[K]['response']> {
      if (disposed) throw new Error('worker client disposed')
      await ready
      if (disposed) throw new Error('worker client disposed')
      if (spawnFailure) throw spawnFailure
      const id = nextId++
      return new Promise<P[K]['response']>((resolve, reject) => {
        pending.set(id, {
          resolve: (value) => resolve(value),
          reject,
        })
        const req: WorkerRequest = { id, type, payload }
        proc.postMessage(req)
      })
    },
    dispose() {
      disposed = true
      markReady()
      for (const p of pending.values()) p.reject(new Error('worker client disposed'))
      pending.clear()
      proc.kill()
    },
  }
}

function isWorkerHostCall(
  value: WorkerResponse | WorkerHostCall,
): value is WorkerHostCall {
  return 'kind' in value && value.kind === 'host-call'
}
