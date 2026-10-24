import { describe, expect, it } from 'vitest'
import {
  admitRenderedDiagram,
  assertRenderedDiagramIndex,
  assertRenderedMarkdown,
  assertRenderedMarkup,
  RENDERED_LIMITS,
} from '../src/renderer/src/viewer/rendered-workload-policy'
import { boundCsvTable, parseCsv } from '../src/renderer/src/viewer/csv-parser'

describe('rendered document admission', () => {
  it('accepts exact Markdown limits and rejects source before DOM construction', () => {
    expect(() =>
      assertRenderedMarkdown('a'.repeat(RENDERED_LIMITS.markdownSource)),
    ).not.toThrow()
    expect(() =>
      assertRenderedMarkdown('a'.repeat(RENDERED_LIMITS.markdownSource + 1)),
    ).toThrow('Use Source')
    expect(() =>
      assertRenderedMarkup('<p></p>'.repeat(RENDERED_LIMITS.elements)),
    ).not.toThrow()
    expect(() =>
      assertRenderedMarkup('<p></p>'.repeat(RENDERED_LIMITS.elements + 1)),
    ).toThrow('elements')
    expect(() =>
      assertRenderedMarkup('a'.repeat(RENDERED_LIMITS.markupCharacters + 1)),
    ).toThrow('output')
  })

  it('bounds aggregate diagram work even when each diagram fits its individual limit', () => {
    expect(() => assertRenderedDiagramIndex(RENDERED_LIMITS.diagrams - 1)).not.toThrow()
    expect(() => assertRenderedDiagramIndex(RENDERED_LIMITS.diagrams)).toThrow(
      'Additional diagrams',
    )
    const svg = '<svg>' + '<g/>'.repeat(2200) + '</svg>'
    const first = admitRenderedDiagram({ elements: 100, characters: 0 }, svg, 1)
    expect(() => admitRenderedDiagram(first, svg, 1)).toThrow('document rendering limit')
    expect(() =>
      admitRenderedDiagram(
        { elements: 0, characters: RENDERED_LIMITS.markupCharacters },
        '<svg/>',
        0,
      ),
    ).toThrow('document rendering limit')
  })

  it('bounds the reproduction CSV including rectangular padding and discloses omitted rows', () => {
    const source = Array.from({ length: 500 }, () =>
      Array.from({ length: 100 }, () => 'cell').join(','),
    ).join('\n')
    const table = boundCsvTable(parseCsv(source))
    expect(table.rows.length * 100).toBe(RENDERED_LIMITS.csvCells)
    expect(table.totalRows).toBe(500)
    expect(table.totalColumns).toBe(100)
    expect(table.truncated).toBe(true)
    const ragged = boundCsvTable(
      parseCsv('a\n' + ','.repeat(99) + '\n' + 'x\n'.repeat(499)),
    )
    expect(ragged.rows.length * 100).toBeLessThanOrEqual(RENDERED_LIMITS.csvCells)
  })

  it('bounds individual and aggregate cell text without changing ordinary data', () => {
    const normal = parseCsv('name,note\nAda,"hello, world"')
    expect(boundCsvTable(normal)).toEqual(normal)
    const table = boundCsvTable(
      parseCsv(Array.from({ length: 100 }, () => 'x'.repeat(2000)).join(',')),
    )
    expect(
      table.rows.flat().every((cell) => cell.length <= RENDERED_LIMITS.csvCellCharacters),
    ).toBe(true)
    expect(table.rows.flat().join('').length).toBeLessThanOrEqual(
      RENDERED_LIMITS.csvCharacters,
    )
    expect(table.contentTruncated).toBe(true)
  })
})
