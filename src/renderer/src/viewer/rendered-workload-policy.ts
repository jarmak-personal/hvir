/** Admission runs before DOM construction. Limits count UTF-16 code units. */
export const RENDERED_LIMITS = {
  markdownSource: 256 * 1024,
  markupCharacters: 256 * 1024,
  elements: 4000,
  diagrams: 8,
  csvCells: 2000,
  csvCharacters: 64 * 1024,
  csvCellCharacters: 1024,
} as const

export function assertRenderedMarkdown(source: string): void {
  if (source.length > RENDERED_LIMITS.markdownSource)
    throw new Error(
      'Markdown preview unavailable: document exceeds the rendering limit. Use Source to inspect the complete document.',
    )
}

export function assertRenderedMarkup(html: string): void {
  if (html.length > RENDERED_LIMITS.markupCharacters)
    throw new Error(
      'Markdown preview unavailable: output exceeds the rendering limit. Use Source to inspect the complete document.',
    )
  renderedElementCount(html)
}

export function renderedElementCount(html: string): number {
  let elements = 0
  // Markdown is generated with raw HTML disabled. Count opening tags before any DOM parse.
  const tags = /<[a-z][^>]*>/gi
  while (tags.exec(html)) {
    if (++elements > RENDERED_LIMITS.elements)
      throw new Error(
        'Markdown preview unavailable: too many rendered elements. Use Source to inspect the complete document.',
      )
  }
  return elements
}

export interface RenderedDiagramBudget {
  readonly elements: number
  readonly characters: number
}

export function assertRenderedDiagramIndex(index: number): void {
  if (index >= RENDERED_LIMITS.diagrams)
    throw new Error(
      'Additional diagrams omitted to keep the preview responsive. Use Source.',
    )
}

export function admitRenderedDiagram(
  current: RenderedDiagramBudget,
  svg: string,
  replacedElements: number,
): RenderedDiagramBudget {
  const next = {
    elements: current.elements + renderedElementCount(svg) - replacedElements,
    characters: current.characters + svg.length,
  }
  if (
    next.elements > RENDERED_LIMITS.elements ||
    next.characters > RENDERED_LIMITS.markupCharacters
  )
    throw new Error('Diagram omitted: document rendering limit reached. Use Source.')
  return next
}
