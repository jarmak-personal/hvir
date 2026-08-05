import {
  type MarkdownRenderRequest,
  type MarkdownRenderResponse,
} from './render-protocol'
import { renderMarkdownDocument } from './markdown-renderer'
import { createViewerGrammarRegistry } from './shiki-grammar-registry'

const grammars = createViewerGrammarRegistry()

self.onmessage = (event: MessageEvent<MarkdownRenderRequest>): void => {
  void render(event.data)
}

async function render(request: MarkdownRenderRequest): Promise<void> {
  try {
    post({
      id: request.id,
      ok: true,
      html: await renderMarkdownDocument(request.markdown, request.theme, grammars),
    })
  } catch (error) {
    post({
      id: request.id,
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    })
  }
}

function post(message: MarkdownRenderResponse): void {
  self.postMessage(message)
}
