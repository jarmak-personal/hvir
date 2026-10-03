import { renderMarkdownDocument } from '../shared/presentation/document-markdown/rendering'
import { SELECTED_MARKDOWN_LIMITS } from '../shared/presentation/document-markdown/contract'
import type { WorkerRequest, WorkerResponse } from '../shared/worker-protocol'
interface ParentPort {
  on(event: 'message', callback: (event: { data: WorkerRequest }) => void): void
  postMessage(value: WorkerResponse): void
}
const port = (process as unknown as { parentPort?: ParentPort }).parentPort
if (!port) throw new Error('document-worker must run as an Electron utility process')
port.on('message', ({ data }) => {
  void render(data)
})
async function render(request: WorkerRequest): Promise<void> {
  try {
    if (
      request.type !== 'render' ||
      typeof request.payload !== 'string' ||
      Buffer.byteLength(request.payload) > SELECTED_MARKDOWN_LIMITS.textBytes
    )
      throw new Error('Invalid bounded document rendering request')
    const html = await renderMarkdownDocument(
      request.payload,
      'dark',
      { load: () => Promise.resolve(undefined) },
      'selected',
    )
    port!.postMessage({
      id: request.id,
      ok: true,
      result: {
        html: Buffer.byteLength(html) > SELECTED_MARKDOWN_LIMITS.htmlBytes ? null : html,
        workerPid: process.pid,
      },
    })
  } catch (error) {
    port!.postMessage({
      id: request.id,
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    })
  }
}
