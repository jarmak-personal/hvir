import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  HighlightResponse,
  HighlightWorkerCommand,
} from '../src/renderer/src/viewer/highlight-protocol'
import { HIGHLIGHT_BATCH_TOKENS } from '../src/renderer/src/viewer/highlight-protocol'

const { load, codeToTokens } = vi.hoisted(() => ({
  load: vi.fn(),
  codeToTokens: vi.fn(),
}))
vi.mock('../src/renderer/src/viewer/shiki-grammar-registry', () => ({
  createViewerGrammarRegistry: () => ({ load }),
}))
const worker = {
  onmessage: undefined as undefined | ((event: { data: HighlightWorkerCommand }) => void),
  postMessage: vi.fn<(response: HighlightResponse) => void>(),
}
beforeEach(async () => {
  vi.stubGlobal('self', worker)
  load.mockResolvedValue({ id: 'js', highlighter: { codeToTokens } })
  codeToTokens.mockReturnValue({
    tokens: [
      Array.from({ length: HIGHLIGHT_BATCH_TOKENS * 2 + 1 }, (_, offset) => ({
        content: 'x',
        offset,
        color: '#abcdef',
      })),
    ],
  })
  await import('../src/renderer/src/viewer/highlight.worker')
})
afterEach(() => {
  vi.unstubAllGlobals()
  vi.resetModules()
  vi.clearAllMocks()
})
function send(data: HighlightWorkerCommand): void {
  worker.onmessage!({ data })
}
function messages(): HighlightResponse[] {
  return worker.postMessage.mock.calls.map(([message]) => message)
}
async function settle(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()
}
const request = { id: 1, code: 'dense', language: 'js' as const, theme: 'dark' as const }

describe('highlight producer backpressure', () => {
  it('bounds a dense single line by tokens and waits for each renderer acknowledgement', async () => {
    send(request)
    await settle()
    expect(messages()).toHaveLength(1)
    expect(messages()[0]).toMatchObject({ type: 'batch', id: 1 })
    const sizes = () =>
      messages()
        .filter((message) => message.type === 'batch')
        .map((message) => message.tokens.length)
    expect(sizes()).toEqual([HIGHLIGHT_BATCH_TOKENS])
    send({ type: 'ack', id: 99 })
    await settle()
    expect(messages()).toHaveLength(1)
    for (let i = 0; i < 3; i++) {
      send({ type: 'ack', id: 1 })
      await settle()
    }
    expect(sizes()).toEqual([HIGHLIGHT_BATCH_TOKENS, HIGHLIGHT_BATCH_TOKENS, 1])
    expect(messages().at(-1)).toEqual({ type: 'done', id: 1, language: 'js' })
  })

  it('releases cancelled producers without publishing stale tokens or affecting a sibling', async () => {
    send(request)
    send({ ...request, id: 2 })
    await settle()
    expect(messages()).toHaveLength(2)
    send({ type: 'cancel', id: 1 })
    await settle()
    send({ type: 'ack', id: 1 })
    send({ type: 'ack', id: 2 })
    await settle()
    expect(messages().filter((message) => message.id === 1)).toHaveLength(1)
    expect(messages().filter((message) => message.id === 2)).toHaveLength(2)
    send({ type: 'cancel', id: 2 })
    await settle()
  })

  it('does not tokenize a cancelled request after deferred grammar loading', async () => {
    let resolve!: (value: unknown) => void
    load.mockReturnValueOnce(
      new Promise((done) => {
        resolve = done
      }),
    )
    send(request)
    send({ type: 'cancel', id: 1 })
    resolve({ id: 'js', highlighter: { codeToTokens } })
    await settle()
    expect(codeToTokens).not.toHaveBeenCalled()
    expect(messages()).toHaveLength(0)
  })
})
