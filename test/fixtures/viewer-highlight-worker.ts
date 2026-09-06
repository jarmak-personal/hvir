import type {
  HighlightRequest,
  HighlightResponse,
} from '../../src/renderer/src/viewer/highlight-protocol'
import type { HighlightWorkerPort } from '../../src/renderer/src/viewer/highlight-request'

/** Immediate worker boundary: no editor, scheduling, or tokenizer simulation. */
export class ViewerHighlightWorker extends EventTarget implements HighlightWorkerPort {
  readonly requests: HighlightRequest[] = []
  readonly messages = new Set<EventListenerOrEventListenerObject>()
  readonly errors = new Set<EventListenerOrEventListenerObject>()
  failPost = false

  override addEventListener(
    type: 'message',
    listener: (event: MessageEvent<HighlightResponse>) => void,
  ): void
  override addEventListener(type: 'error', listener: (event: ErrorEvent) => void): void
  override addEventListener(
    type: string,
    listener: EventListenerOrEventListenerObject | null,
  ): void
  override addEventListener(
    type: string,
    listener:
      | EventListenerOrEventListenerObject
      | ((event: MessageEvent<HighlightResponse>) => void)
      | ((event: ErrorEvent) => void)
      | null,
  ): void {
    if (listener)
      (type === 'message' ? this.messages : this.errors).add(listener as EventListener)
    super.addEventListener(type, listener as EventListener)
  }

  override removeEventListener(
    type: 'message',
    listener: (event: MessageEvent<HighlightResponse>) => void,
  ): void
  override removeEventListener(type: 'error', listener: (event: ErrorEvent) => void): void
  override removeEventListener(
    type: string,
    listener: EventListenerOrEventListenerObject | null,
  ): void
  override removeEventListener(
    type: string,
    listener:
      | EventListenerOrEventListenerObject
      | ((event: MessageEvent<HighlightResponse>) => void)
      | ((event: ErrorEvent) => void)
      | null,
  ): void {
    if (listener)
      (type === 'message' ? this.messages : this.errors).delete(listener as EventListener)
    super.removeEventListener(type, listener as EventListener)
  }

  postMessage(request: HighlightRequest): void {
    if (this.failPost) throw new Error('unavailable')
    this.requests.push(request)
  }

  respond(response: HighlightResponse): void {
    this.dispatchEvent(new MessageEvent('message', { data: response }))
  }
}
