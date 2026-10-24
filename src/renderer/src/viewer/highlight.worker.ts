import type {
  HighlightRequest,
  HighlightWorkerCommand,
  HighlightResponse,
  HighlightToken,
} from './highlight-protocol'
import { HIGHLIGHT_BATCH_TOKENS } from './highlight-protocol'
import { createViewerGrammarRegistry } from './shiki-grammar-registry'

const grammars = createViewerGrammarRegistry()

// Each request can have at most one unacknowledged token batch. Cancellation releases
// suspended producers; the shared grammar worker retains no abandoned request queues.
const requests = new Map<number, { cancelled: boolean; resume?: () => void }>()
self.onmessage = ({ data }: MessageEvent<HighlightWorkerCommand>): void => {
  if ('type' in data) {
    const request = requests.get(data.id)
    if (!request) return
    if (data.type === 'cancel') request.cancelled = true
    request.resume?.()
    return
  }
  const state = { cancelled: false }
  requests.set(data.id, state)
  void highlight(data, state)
}

async function highlight(
  request: HighlightRequest,
  state: { cancelled: boolean; resume?: () => void },
): Promise<void> {
  try {
    const loaded = await grammars.load(request.language)
    if (state.cancelled) return
    if (!loaded) {
      post({ type: 'plain', id: request.id })
      return
    }
    const result = loaded.highlighter.codeToTokens(request.code, {
      lang: loaded.id,
      theme: request.theme === 'light' ? 'github-light-default' : 'dark-plus',
    })

    let batch: HighlightToken[] = []
    const flush = async (): Promise<void> => {
      const acknowledged = new Promise<void>((resolve) => {
        state.resume = resolve
      })
      post({ type: 'batch', id: request.id, tokens: batch })
      batch = []
      await acknowledged
      state.resume = undefined
    }
    for (let lineIndex = 0; lineIndex < result.tokens.length; lineIndex += 1) {
      const line = result.tokens[lineIndex]
      if (!line) continue
      for (const token of line) {
        if (!token.content || (!token.color && !token.bgColor && !token.fontStyle))
          continue
        batch.push({
          from: token.offset,
          to: token.offset + token.content.length,
          color: token.color,
          backgroundColor: token.bgColor,
          fontStyle: token.fontStyle,
        })
        if (batch.length === HIGHLIGHT_BATCH_TOKENS) {
          await flush()
          if (state.cancelled) return
        }
      }
    }
    if (batch.length > 0) await flush()
    if (state.cancelled) return
    post({ type: 'done', id: request.id, language: loaded.id })
  } catch (error) {
    if (state.cancelled) return
    post({
      type: 'error',
      id: request.id,
      message: error instanceof Error ? error.message : String(error),
    })
  } finally {
    requests.delete(request.id)
  }
}

function post(message: HighlightResponse): void {
  self.postMessage(message)
}
