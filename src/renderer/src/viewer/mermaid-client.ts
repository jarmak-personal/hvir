import {
  assertMermaidRequest,
  assertMermaidOutput,
} from '../../../shared/presentation/mermaid-contract'
import { admitMermaidSvg } from '../../../shared/presentation/mermaid-svg'

export function renderMermaid(
  source: string,
  theme: 'light' | 'dark',
  signal: AbortSignal,
): Promise<string> {
  const id = crypto.randomUUID()
  const request = { id, source, theme }
  const cancel = (): void => window.hvir.send('mermaid:cancel', { id })
  try {
    assertMermaidRequest(request)
  } catch (error) {
    return Promise.reject(error instanceof Error ? error : new Error(String(error)))
  }
  if (signal.aborted) return Promise.reject(new Error('Diagram rendering cancelled'))
  signal.addEventListener('abort', cancel, { once: true })
  return window.hvir
    .invoke('mermaid:render', request)
    .then((svg) => {
      if (signal.aborted) throw new Error('Diagram rendering cancelled')
      assertMermaidOutput(svg)
      return admitMermaidSvg(svg, `diagram-${id}`)
    })
    .finally(() => signal.removeEventListener('abort', cancel))
}
