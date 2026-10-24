export function createFindWorker(): Worker {
  return new Worker(new URL('./find.worker.ts', import.meta.url), { type: 'module' })
}
