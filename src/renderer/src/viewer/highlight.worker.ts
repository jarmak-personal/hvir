import { createHighlighterCore } from 'shiki/core'
import { createJavaScriptRegexEngine } from 'shiki/engine/javascript'

import type {
  HighlightRequest,
  HighlightResponse,
  HighlightToken,
} from './highlight-protocol'

const highlighterPromise = createHighlighterCore({
  themes: [import('@shikijs/themes/dark-plus')],
  langs: [
    import('@shikijs/langs/bash'),
    import('@shikijs/langs/css'),
    import('@shikijs/langs/go'),
    import('@shikijs/langs/html'),
    import('@shikijs/langs/javascript'),
    import('@shikijs/langs/jsx'),
    import('@shikijs/langs/json'),
    import('@shikijs/langs/markdown'),
    import('@shikijs/langs/python'),
    import('@shikijs/langs/rust'),
    import('@shikijs/langs/tsx'),
    import('@shikijs/langs/typescript'),
  ],
  // The JS engine is worker-friendly and avoids a second WASM startup cost.
  engine: createJavaScriptRegexEngine(),
})

self.onmessage = (event: MessageEvent<HighlightRequest>): void => {
  void highlight(event.data)
}

async function highlight(request: HighlightRequest): Promise<void> {
  try {
    const highlighter = await highlighterPromise
    const result = highlighter.codeToTokens(request.code, {
      lang: request.language,
      theme: 'dark-plus',
    })

    let batch: HighlightToken[] = []
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
      }
      // Stream decorations in bounded batches so CodeMirror can paint early.
      if ((lineIndex + 1) % 200 === 0 && batch.length > 0) {
        post({ type: 'batch', id: request.id, tokens: batch })
        batch = []
      }
    }
    if (batch.length > 0) post({ type: 'batch', id: request.id, tokens: batch })
    post({ type: 'done', id: request.id })
  } catch (error) {
    post({
      type: 'error',
      id: request.id,
      message: error instanceof Error ? error.message : String(error),
    })
  }
}

function post(message: HighlightResponse): void {
  self.postMessage(message)
}
