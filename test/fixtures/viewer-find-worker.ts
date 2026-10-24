import { vi } from 'vitest'
import type {
  FindWorkerResponse,
  FindWorkerRequest,
} from '../../src/renderer/src/viewer/find-worker-protocol'

/** Immediate worker boundary; does not simulate matching or editor updates. */
export class ViewerFindWorker {
  onmessage?: (event: MessageEvent<FindWorkerResponse>) => void
  onerror?: () => void
  postMessage = vi.fn<(request: FindWorkerRequest) => void>()
  terminate = vi.fn()
  respond(data: FindWorkerResponse): void {
    this.onmessage?.({ data } as MessageEvent<FindWorkerResponse>)
  }
}
