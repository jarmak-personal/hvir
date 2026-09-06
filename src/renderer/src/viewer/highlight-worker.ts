let sharedHighlightWorker: Worker | undefined

export function getHighlightWorker(): Worker {
  sharedHighlightWorker ??= new Worker(
    new URL('./highlight.worker.ts', import.meta.url),
    { type: 'module' },
  )
  return sharedHighlightWorker
}

if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    sharedHighlightWorker?.terminate()
    sharedHighlightWorker = undefined
  })
}
