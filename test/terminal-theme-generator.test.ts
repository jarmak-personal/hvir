import { describe, expect, it } from 'vitest'

import {
  buildTerminalThemeCatalog,
  parseGhosttyTheme,
  renderTerminalThemeCatalog,
  TERMINAL_THEME_SOURCE,
} from '../scripts/generate-terminal-theme-catalog.mts'
import {
  GENERATED_TERMINAL_THEME_CATALOG,
  GENERATED_TERMINAL_THEME_CATALOG_PROVENANCE,
} from '../src/renderer/src/terminal/generated-terminal-theme-catalog'
import {
  TERMINAL_COLOR_KEYS,
  TERMINAL_COLOR_PATTERN,
} from '../src/renderer/src/terminal/terminal-palette'

describe('terminal theme catalog generator', () => {
  it('maps only the complete color subset into one deterministic palette', () => {
    const theme = parseGhosttyTheme('Example Theme', completeTheme())

    expect(theme.id).toMatch(/^ghostty-example-theme-[0-9a-f]{8}$/)
    expect(theme.name).toBe('Example Theme')
    expect(theme.palette).toEqual({
      background: '#101010',
      foreground: '#eeeeee',
      cursor: '#abcdef',
      cursorText: '#010203',
      selectionBackground: '#202020',
      selectionForeground: '#fefefe',
      black: '#000000',
      red: '#010101',
      green: '#020202',
      yellow: '#030303',
      blue: '#040404',
      magenta: '#050505',
      cyan: '#060606',
      white: '#070707',
      brightBlack: '#080808',
      brightRed: '#090909',
      brightGreen: '#0a0a0a',
      brightYellow: '#0b0b0b',
      brightBlue: '#0c0c0c',
      brightMagenta: '#0d0d0d',
      brightCyan: '#0e0e0e',
      brightWhite: '#0f0f0f',
    })
  })

  it.each([
    ['unsupported directive', `${completeTheme()}font-family = Example\n`],
    ['included configuration', `${completeTheme()}config-file = other.conf\n`],
    ['executable command', `${completeTheme()}command = dangerous\n`],
    ['nested theme', `${completeTheme()}theme = Other\n`],
    ['duplicate field', `${completeTheme()}foreground = #ffffff\n`],
    ['duplicate palette index', `${completeTheme()}palette = 15=#ffffff\n`],
    ['wide color syntax', completeTheme().replace('#101010', '#fff')],
    ['malformed color syntax', completeTheme().replace('#101010', 'rgb(1, 1, 1)')],
    ['out-of-range palette', completeTheme().replace('palette = 15=', 'palette = 16=')],
    ['missing field', completeTheme().replace('cursor-text = #010203\n', '')],
    ['comment content', `${completeTheme()}# source command = ignored\n`],
    ['whitespace-only content', `${completeTheme()}  \n`],
  ])('fails %s closed', (_label, source) => {
    expect(() => parseGhosttyTheme('Rejected', source)).toThrow(/Rejected:\d+:/)
  })

  it('sorts input and reports excluded invalid files with deterministic diagnostics', () => {
    const first = buildTerminalThemeCatalog({
      'Z invalid': 'include = other',
      'A valid': completeTheme(),
      'B invalid': completeTheme().replace('palette = 8=#080808\n', ''),
    })
    const second = buildTerminalThemeCatalog({
      'B invalid': completeTheme().replace('palette = 8=#080808\n', ''),
      'A valid': completeTheme(),
      'Z invalid': 'include = other',
    })

    expect(second).toEqual(first)
    expect(first.themes.map((theme) => theme.name)).toEqual(['A valid'])
    expect(first.diagnostics).toEqual([
      expect.stringMatching(/^B invalid:\d+: incomplete palette; missing brightBlack$/),
      'Z invalid:1: unsupported directive "include"',
    ])
  })

  it('records exact bounded provenance and retains the complete generated catalog', () => {
    expect(GENERATED_TERMINAL_THEME_CATALOG_PROVENANCE).toEqual(TERMINAL_THEME_SOURCE)
    expect(GENERATED_TERMINAL_THEME_CATALOG).toHaveLength(463)
    expect(new Set(GENERATED_TERMINAL_THEME_CATALOG.map((theme) => theme.id)).size).toBe(
      463,
    )
    expect(
      GENERATED_TERMINAL_THEME_CATALOG.every(
        (theme) =>
          Object.keys(theme.palette).length === TERMINAL_COLOR_KEYS.length &&
          TERMINAL_COLOR_KEYS.every((key) =>
            TERMINAL_COLOR_PATTERN.test(theme.palette[key]),
          ),
      ),
    ).toBe(true)
    expect(TERMINAL_THEME_SOURCE.maximumThemeCount).toBe(512)
    expect(TERMINAL_THEME_SOURCE.maximumThemeBytes).toBe(4_096)
    expect(TERMINAL_THEME_SOURCE.sourceTreeSha256).toMatch(/^[0-9a-f]{64}$/)
  })

  it('renders identical source maps identically without executable output', () => {
    const themes = buildTerminalThemeCatalog({
      Beta: completeTheme('#202020'),
      Alpha: completeTheme(),
    }).themes
    const rendered = renderTerminalThemeCatalog(themes)

    expect(rendered).toBe(renderTerminalThemeCatalog([...themes]))
    expect(rendered.indexOf('"name":"Alpha"')).toBeLessThan(
      rendered.indexOf('"name":"Beta"'),
    )
    expect(rendered).not.toContain('eval(')
    expect(rendered).not.toContain('Function(')
    expect(rendered).not.toContain('fetch(')
  })
})

function completeTheme(background = '#101010'): string {
  const palette = Array.from(
    { length: 16 },
    (_, index) => `palette = ${index}=#${index.toString(16).padStart(2, '0').repeat(3)}`,
  )
  return [
    ...palette,
    `background = ${background}`,
    'foreground = #EEEEEE',
    'cursor-color = #ABCDEF',
    'cursor-text = #010203',
    'selection-background = #202020',
    'selection-foreground = #FEFEFE',
    '',
  ].join('\n')
}
