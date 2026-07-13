import { useSyncExternalStore } from 'react'

import type { MarkdownRenderResponse } from './render-protocol'

let worker: Worker | undefined
let nextRequestId = 0
const pending = new Map<
  number,
  { readonly resolve: (html: string) => void; readonly reject: (error: Error) => void }
>()
let generation = 0
const generationListeners = new Set<() => void>()

function getWorker(): Worker {
  if (worker) return worker
  const activeWorker = new Worker(new URL('./markdown.worker.ts', import.meta.url), {
    type: 'module',
  })
  worker = activeWorker
  activeWorker.addEventListener(
    'message',
    (event: MessageEvent<MarkdownRenderResponse>) => {
      const request = pending.get(event.data.id)
      if (!request) return
      pending.delete(event.data.id)
      if (event.data.ok) request.resolve(event.data.html)
      else request.reject(new Error(event.data.error))
    },
  )
  activeWorker.addEventListener('error', () => {
    if (worker !== activeWorker) return
    const error = new Error('Markdown renderer unavailable')
    for (const request of pending.values()) request.reject(error)
    pending.clear()
    activeWorker.terminate()
    worker = undefined
  })
  return activeWorker
}

export function renderMarkdown(markdown: string): Promise<string> {
  const id = ++nextRequestId
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject })
    try {
      getWorker().postMessage({ id, markdown })
    } catch (reason) {
      pending.delete(id)
      reject(reason instanceof Error ? reason : new Error(String(reason)))
    }
  })
}

export function useMarkdownRendererGeneration(): number {
  return useSyncExternalStore(
    (listener) => {
      generationListeners.add(listener)
      return () => generationListeners.delete(listener)
    },
    () => generation,
    () => generation,
  )
}

export function resetMarkdownRenderer(): void {
  const error = new Error('Markdown renderer reloading')
  for (const request of pending.values()) request.reject(error)
  pending.clear()
  worker?.terminate()
  worker = undefined
  generation += 1
  for (const listener of generationListeners) listener()
}

if (import.meta.hot) {
  import.meta.hot.dispose(resetMarkdownRenderer)
}
