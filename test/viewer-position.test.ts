import MarkdownIt from 'markdown-it'
import { describe, expect, it } from 'vitest'

import {
  enableSourceLineAnchors,
  enableTaskLists,
} from '../src/renderer/src/viewer/markdown-extensions'
import {
  approximateLineAtScroll,
  approximateScrollForLine,
  documentLineCount,
  nearestSourceAnchor,
} from '../src/renderer/src/viewer/viewer-position'

describe('viewer document position', () => {
  it('maps fallback rendered progress to source lines in both directions', () => {
    expect(documentLineCount('one\ntwo\nthree\n')).toBe(4)
    expect(approximateLineAtScroll(400, 1_000, 200, 101)).toBe(51)
    expect(approximateScrollForLine(51, 1_000, 200, 101)).toBe(400)
    expect(approximateLineAtScroll(5_000, 1_000, 200, 101)).toBe(101)
  })

  it('chooses the nearest rendered source block at or before a line', () => {
    const anchors = [
      { line: 1, top: 0 },
      { line: 12, top: 140 },
      { line: 28, top: 300 },
    ]
    expect(nearestSourceAnchor(anchors, 20)).toEqual({ line: 12, top: 140 })
    expect(nearestSourceAnchor(anchors, 28)).toEqual({ line: 28, top: 300 })
    expect(nearestSourceAnchor(anchors, 0)).toEqual({ line: 1, top: 0 })
  })

  it('marks Markdown block starts with their one-based source lines', () => {
    const markdown = enableSourceLineAnchors(enableTaskLists(new MarkdownIt()))
    const html = markdown.render(
      '# Heading\n\nParagraph\n\n```ts\nconst value = 1\n```\n',
    )

    expect(html).toContain('<h1 data-source-line="1">')
    expect(html).toContain('<p data-source-line="3">')
    expect(html).toContain('data-source-line="5"')
  })
})
