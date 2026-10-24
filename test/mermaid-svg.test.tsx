// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { admitMermaidSvg } from '../src/shared/presentation/mermaid-svg'
import { MERMAID_LIMITS } from '../src/shared/presentation/mermaid-contract'

describe('passive Mermaid SVG admission', () => {
  it('keeps text and diagram-local references while removing resource and stylesheet authority', () => {
    const svg = admitMermaidSvg(
      '<svg xmlns="http://www.w3.org/2000/svg"><style>body { display:none }</style><defs><marker id="arrow"><path d="M0 0"/></marker></defs><path marker-end="url(#arrow)"/><text style="fill:red;position:fixed;background:url(file:///secret)">Find me</text><image href="file:///secret"/><a href="https://example.com"><text>label</text></a><script>alert(1)</script></svg>',
      'test',
    )
    expect(svg).toContain('Find me')
    expect(svg).toContain('label')
    expect(svg).toContain('url(#test-')
    expect(svg).not.toMatch(/<style|<script|<image|href=|position:|background:/)
    expect(svg).toContain('fill:red')
  })
  it('retains passive HTML labels inside foreignObject without admitting layout escape', () => {
    const svg = admitMermaidSvg(
      '<svg xmlns="http://www.w3.org/2000/svg"><foreignObject width="100" height="40"><div xmlns="http://www.w3.org/1999/xhtml" style="position:fixed;color:red"><span>HTML label</span><img src="file:///secret"/></div></foreignObject></svg>',
      'label',
    )
    expect(svg).toContain('foreignObject')
    expect(svg).toContain('HTML label')
    expect(svg).not.toMatch(/position:|<img|file:/)
  })
  it('keeps accessible identities local and strips animation, interaction and source-anchor spoofing', () => {
    const svg = admitMermaidSvg(
      '<svg aria-labelledby="chart-title"><title id="chart-title">Diagram</title><animateMotion path="M0,0 L100,100"/><foreignObject><div xmlns="http://www.w3.org/1999/xhtml" data-source-line="900" class="workbench" contenteditable="true"><select><option>Label</option></select></div></foreignObject></svg>',
      'safe',
    )
    expect(svg).toContain('aria-labelledby="safe-1"')
    expect(svg).toContain('id="safe-1"')
    expect(svg).toContain('Label')
    expect(svg).not.toMatch(
      /animateMotion|data-source-line|class=|contenteditable|<select|<option/,
    )
    expect(() =>
      admitMermaidSvg('<svg><g id="duplicate"/><g id="duplicate"/></svg>', 'safe'),
    ).toThrow('duplicate')
  })
  it('blocks escaped paint resources and legacy HTML resource attributes', () => {
    const svg = admitMermaidSvg(
      '<svg aria-owns="workbench" xml:base="file:///private/"><path fill="u\\72l(../../private.png)"/><foreignObject><table xmlns="http://www.w3.org/1999/xhtml" background="../../private.png"><tbody><tr><td>Label</td></tr></tbody></table></foreignObject></svg>',
      'safe',
    )
    expect(svg).toContain('Label')
    expect(svg).not.toMatch(/private|background=|aria-owns|xml:base/)
  })
  it('rejects size and structural overflow and disallows cross-document fragments', () => {
    expect(() =>
      admitMermaidSvg('x'.repeat(MERMAID_LIMITS.outputCharacters + 1), 'a'),
    ).toThrow('output')
    expect(() =>
      admitMermaidSvg('<svg>' + '<g/>'.repeat(MERMAID_LIMITS.elements) + '</svg>', 'a'),
    ).toThrow('elements')
    expect(admitMermaidSvg('<svg><path fill="url(#outside)"/></svg>', 'a')).not.toContain(
      'url(',
    )
  })
})
