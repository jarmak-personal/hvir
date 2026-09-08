import {
  languageForPath,
  type HighlightRequest,
  type HighlightResponse,
  type HighlightToken,
} from './highlight-protocol'
import { canHighlightSource } from './viewer-workload-policy'
import type { HostPath } from '../../../shared/host-path'

/** Requests own listeners; the renderer's shared worker outlives every source view. */
export interface HighlightWorkerPort {
  addEventListener(
    type: 'message',
    listener: (event: MessageEvent<HighlightResponse>) => void,
  ): void
  addEventListener(type: 'error', listener: (event: ErrorEvent) => void): void
  removeEventListener(
    type: 'message',
    listener: (event: MessageEvent<HighlightResponse>) => void,
  ): void
  removeEventListener(type: 'error', listener: (event: ErrorEvent) => void): void
  postMessage(request: HighlightRequest): void
}

let nextRequestId = 0

export function requestSourceHighlight(
  getWorker: () => HighlightWorkerPort,
  input: {
    readonly path: HostPath
    readonly content: string
    readonly size: number
    readonly theme: 'dark' | 'light'
  },
  output: {
    readonly status: (status: string) => void
    readonly tokens: (tokens: readonly HighlightToken[]) => void
  },
): () => void {
  if (!canHighlightSource(input.size)) {
    output.status('large file · highlighting off')
    return () => undefined
  }
  const language = languageForPath(input.path.path)
  if (!language) {
    output.status('plain text')
    return () => undefined
  }
  output.status('highlighting…')
  const id = ++nextRequestId
  let active = true
  let worker: HighlightWorkerPort | undefined
  const dispose = (): void => {
    if (!active) return
    active = false
    worker?.removeEventListener('message', onMessage)
    worker?.removeEventListener('error', onError)
  }
  const onMessage = (event: MessageEvent<HighlightResponse>): void => {
    const message = event.data
    if (!active || message.id !== id) return
    if (message.type === 'batch') {
      output.tokens(message.tokens)
    } else if (message.type === 'done') {
      output.status(message.language)
    } else if (message.type === 'plain') {
      output.status('plain text')
    } else {
      output.status(`highlight failed: ${message.message}`)
    }
  }
  const onError = (event: ErrorEvent): void => {
    if (active) output.status(`highlight worker failed: ${event.message}`)
  }
  try {
    worker = getWorker()
    worker.addEventListener('message', onMessage)
    worker.addEventListener('error', onError)
    worker.postMessage({ id, code: input.content, language, theme: input.theme })
  } catch (reason) {
    dispose()
    output.status(
      `highlight worker failed: ${reason instanceof Error ? reason.message : String(reason)}`,
    )
  }
  return dispose
}
