import mermaid from 'mermaid'
import {
  assertMermaidRequest,
  assertMermaidOutput,
  type MermaidRenderRequest,
} from '../../shared/presentation/mermaid-contract'
import {
  admitMermaidSvg,
  inlineMermaidAppearance,
} from '../../shared/presentation/mermaid-svg'

// Main drives this one content-only function; there is no preload or outbound IPC bridge.
Object.assign(window, {
  renderDiagram: async (request: MermaidRenderRequest): Promise<string> => {
    assertMermaidRequest(request)
    const defaults = mermaid.mermaidAPI.getConfig()
    mermaid.initialize({
      startOnLoad: false,
      securityLevel: 'strict',
      suppressErrorRendering: true,
      theme: request.theme === 'light' ? 'default' : 'dark',
      secure: [
        ...Object.keys(defaults),
        'secure',
        'themeCSS',
        'themeVariables',
        'htmlLabels',
      ],
      maxTextSize: 64 * 1024,
    })
    const { svg } = await mermaid.render(`diagram-${request.id}`, request.source)
    assertMermaidOutput(svg)
    const template = document.createElement('template')
    template.innerHTML = svg
    const root = template.content.firstElementChild as SVGElement | null
    if (!root || root.localName !== 'svg') throw new Error('Diagram output unavailable')
    document.body.replaceChildren(root)
    inlineMermaidAppearance(root)
    return admitMermaidSvg(root.outerHTML, `diagram-${request.id}`)
  },
})
