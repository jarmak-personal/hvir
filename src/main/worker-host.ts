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

import type { WorkerRequest, WorkerResponse } from '../shared'

export interface WorkerClient {
  /** Send a typed request; resolves with the worker's typed result. */
  request<Res>(type: string, payload: unknown): Promise<Res>
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

export function createWorkerClient(
  entryPath: string,
  serviceName?: string,
): WorkerClient {
  const proc: UtilityProcess = utilityProcess.fork(entryPath, [], {
    serviceName: serviceName ?? 'hvir-worker',
    stdio: 'inherit',
  })

  const pending = new Map<number, Pending>()
  let nextId = 1
  let disposed = false

  // Gate sends until the child has actually spawned, so no message is dropped.
  const ready = new Promise<void>((resolve) => {
    proc.once('spawn', () => resolve())
  })

  proc.on('message', (msg: WorkerResponse) => {
    const p = pending.get(msg.id)
    if (!p) return
    pending.delete(msg.id)
    if (msg.ok) p.resolve(msg.result)
    else p.reject(new Error(msg.error))
  })

  proc.on('exit', (code) => {
    const err = new Error(`worker exited (code ${code})`)
    for (const p of pending.values()) p.reject(err)
    pending.clear()
  })

  return {
    get pid() {
      return proc.pid
    },
    async request<Res>(type: string, payload: unknown): Promise<Res> {
      if (disposed) throw new Error('worker client disposed')
      await ready
      const id = nextId++
      return new Promise<Res>((resolve, reject) => {
        pending.set(id, { resolve: (value) => resolve(value as Res), reject })
        const req: WorkerRequest = { id, type, payload }
        proc.postMessage(req)
      })
    },
    dispose() {
      disposed = true
      for (const p of pending.values()) p.reject(new Error('worker client disposed'))
      pending.clear()
      proc.kill()
    },
  }
}
