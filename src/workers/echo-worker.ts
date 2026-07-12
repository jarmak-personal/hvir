/**
 * Trivial echo utility process — the Phase-1 proof that a `src/workers` module
 * runs off-main and round-trips the typed IPC envelope. Later workers (git
 * engine, tokenizer, watcher) follow the same request/response shape.
 */

import {
  ECHO_REQUEST_TYPE,
  type EchoPayload,
  type EchoResult,
  type WorkerRequest,
  type WorkerResponse,
} from '../shared'

/** Minimal view of Electron's utility-process parent port (self-contained so
 *  this file needs no Electron global types). */
interface ParentPort {
  on(event: 'message', listener: (e: { data: WorkerRequest }) => void): void
  postMessage(message: WorkerResponse): void
}

const port = (process as unknown as { parentPort?: ParentPort }).parentPort

if (!port) {
  throw new Error('echo-worker must run as an Electron utility process')
}

port.on('message', ({ data: req }) => {
  if (req.type === ECHO_REQUEST_TYPE) {
    if (!isEchoPayload(req.payload)) {
      port.postMessage({ id: req.id, ok: false, error: 'invalid echo payload' })
      return
    }
    const payload: EchoPayload = req.payload
    const result: EchoResult = { text: payload.text, workerPid: process.pid }
    port.postMessage({ id: req.id, ok: true, result })
  } else {
    port.postMessage({
      id: req.id,
      ok: false,
      error: `unknown request type: ${req.type}`,
    })
  }
})

function isEchoPayload(value: unknown): value is EchoPayload {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { text?: unknown }).text === 'string'
  )
}
