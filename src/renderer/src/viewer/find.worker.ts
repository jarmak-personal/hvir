import { Text } from '@codemirror/state'
import { createSearchQuery } from './viewer-find'
import { FIND_MATCH_PAGE_SIZE } from './find-match-index'
import type { FindWorkerRequest, FindWorkerResponse } from './find-worker-protocol'

let chunks: string[] = []
self.onmessage = ({ data }: MessageEvent<FindWorkerRequest>): void => {
  if (data.type === 'chunk') {
    chunks.push(data.content)
    return
  }
  const doc = Text.of(chunks.join('').split('\n'))
  chunks = []
  const cursor = createSearchQuery(data.query).getCursor(doc)
  let page = new Uint32Array(FIND_MATCH_PAGE_SIZE * 2)
  let offset = 0
  const post = (message: FindWorkerResponse, transfer: Transferable[] = []): void =>
    self.postMessage(message, { transfer })
  for (let next = cursor.next(); !next.done; next = cursor.next()) {
    page[offset++] = next.value.from
    page[offset++] = next.value.to
    if (offset === page.length) {
      post({ type: 'matches', document: data.document, ranges: page }, [page.buffer])
      page = new Uint32Array(FIND_MATCH_PAGE_SIZE * 2)
      offset = 0
    }
  }
  if (offset) {
    const ranges = page.slice(0, offset)
    post({ type: 'matches', document: data.document, ranges }, [ranges.buffer])
  }
  post({ type: 'done', document: data.document })
}
