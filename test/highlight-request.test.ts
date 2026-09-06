import { describe, expect, it, vi } from 'vitest'
import { requestSourceHighlight } from '../src/renderer/src/viewer/highlight-request'
import { SOURCE_HIGHLIGHT_BYTE_LIMIT } from '../src/renderer/src/viewer/viewer-workload-policy'
import { localPath } from '../src/shared'
import { ViewerHighlightWorker } from './fixtures/viewer-highlight-worker'

const input = {
  path: localPath('/repo/example.ts'),
  content: 'const value = 1',
  size: 15,
  theme: 'dark' as const,
}
const sink = () => ({ status: vi.fn(), tokens: vi.fn() })

describe('source highlight request lifetime', () => {
  it('reuses the workload and language policy before acquiring a worker', () => {
    const worker = new ViewerHighlightWorker()
    const getWorker = vi.fn(() => worker)
    const output = sink()
    requestSourceHighlight(
      getWorker,
      { ...input, size: SOURCE_HIGHLIGHT_BYTE_LIMIT + 1 },
      output,
    )()
    expect(output.status).toHaveBeenLastCalledWith('large file · highlighting off')
    requestSourceHighlight(
      getWorker,
      { ...input, path: localPath('/repo/unknown.qzx') },
      output,
    )()
    expect(output.status).toHaveBeenLastCalledWith('plain text')
    expect(getWorker).not.toHaveBeenCalled()
    const dispose = requestSourceHighlight(
      getWorker,
      { ...input, size: SOURCE_HIGHLIGHT_BYTE_LIMIT },
      output,
    )
    expect(worker.requests[0]).toMatchObject({
      code: input.content,
      language: 'ts',
      theme: 'dark',
    })
    dispose()
  })

  it('isolates concurrent request identities and revokes late callbacks without releasing another view', () => {
    const worker = new ViewerHighlightWorker()
    const first = sink()
    const second = sink()
    const releaseFirst = requestSourceHighlight(() => worker, input, first)
    const queuedFirst = [...worker.messages][0] as EventListener
    const releaseSecond = requestSourceHighlight(
      () => worker,
      { ...input, theme: 'light' },
      second,
    )
    const firstId = worker.requests[0]!.id
    const secondId = worker.requests[1]!.id
    expect(firstId).not.toBe(secondId)
    const tokens = [{ from: 0, to: 5, color: '#abcdef' }]
    worker.respond({ type: 'batch', id: secondId, tokens })
    expect(first.tokens).not.toHaveBeenCalled()
    expect(second.tokens).toHaveBeenCalledWith(tokens)
    releaseFirst()
    releaseFirst()
    expect(worker.messages.size).toBe(1)
    expect(worker.errors.size).toBe(1)
    queuedFirst(
      new MessageEvent('message', { data: { type: 'batch', id: firstId, tokens } }),
    )
    expect(first.tokens).not.toHaveBeenCalled()
    worker.respond({ type: 'done', id: secondId, language: 'ts' })
    expect(second.status).toHaveBeenLastCalledWith('ts')
    releaseSecond()
    expect(worker.messages.size).toBe(0)
    expect(worker.errors.size).toBe(0)
  })

  it('retains plain-text and request/worker failure presentation', () => {
    const worker = new ViewerHighlightWorker()
    const output = sink()
    const release = requestSourceHighlight(() => worker, input, output)
    const id = worker.requests[0]!.id
    worker.respond({ type: 'plain', id })
    expect(output.status).toHaveBeenLastCalledWith('plain text')
    worker.respond({ type: 'error', id, message: 'grammar unavailable' })
    expect(output.status).toHaveBeenLastCalledWith(
      'highlight failed: grammar unavailable',
    )
    const event = Object.assign(new Event('error'), { message: 'worker unavailable' })
    worker.dispatchEvent(event)
    expect(output.status).toHaveBeenLastCalledWith(
      'highlight worker failed: worker unavailable',
    )
    release()
    output.status.mockClear()
    worker.respond({ type: 'done', id, language: 'ts' })
    worker.dispatchEvent(event)
    expect(output.status).not.toHaveBeenCalled()
  })

  it('releases partial startup listeners when postMessage throws while a sibling remains active', () => {
    const worker = new ViewerHighlightWorker()
    const sibling = sink()
    const releaseSibling = requestSourceHighlight(() => worker, input, sibling)
    worker.failPost = true
    const failed = sink()
    const releaseFailed = requestSourceHighlight(() => worker, input, failed)
    expect(failed.status).toHaveBeenLastCalledWith('highlight worker failed: unavailable')
    expect(worker.messages.size).toBe(1)
    expect(worker.errors.size).toBe(1)
    releaseFailed()
    worker.respond({ type: 'done', id: worker.requests[0]!.id, language: 'ts' })
    expect(sibling.status).toHaveBeenLastCalledWith('ts')
    releaseSibling()
    expect(worker.messages.size).toBe(0)
    expect(worker.errors.size).toBe(0)
  })

  it('contains a worker-construction failure', () => {
    const output = sink()
    const dispose = requestSourceHighlight(
      () => {
        throw new Error('unavailable')
      },
      input,
      output,
    )
    expect(output.status).toHaveBeenLastCalledWith('highlight worker failed: unavailable')
    dispose()
  })
})
