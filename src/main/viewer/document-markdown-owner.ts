import { SELECTED_MARKDOWN_LIMITS } from '../../shared/presentation/document-markdown/contract'
export interface DocumentMarkdownWorker {
  render(text: string): Promise<string | null>
  dispose(): void
}
/** One physical parse, no queue/cache/replacement. Caller cancellation cannot free the RPC slot. */
export class DocumentMarkdownOwner {
  private worker?: DocumentMarkdownWorker
  private busy = false
  private disposed = false
  constructor(private readonly createWorker: () => DocumentMarkdownWorker) {}
  async render(text: string): Promise<string | null> {
    if (this.disposed) throw new Error('Document renderer is closed')
    if (this.busy)
      throw new Error('Document rendering is already pending; retry explicitly')
    if (Buffer.byteLength(text) > SELECTED_MARKDOWN_LIMITS.textBytes)
      throw new Error('Document parsing input exceeds its byte bound')
    this.busy = true
    try {
      this.worker ??= this.createWorker()
      const html = await this.worker.render(text)
      if (this.disposed) throw new Error('Document renderer is closed')
      return html === null || Buffer.byteLength(html) > SELECTED_MARKDOWN_LIMITS.htmlBytes
        ? null
        : html
    } finally {
      this.busy = false
    }
  }
  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.worker?.dispose()
  }
}
