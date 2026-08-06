import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

const expectedOrder = [
  'base.css',
  'projects.css',
  'health.css',
  'diagnostic-report.css',
  'shell.css',
  'viewer-tabs.css',
  'viewer-find.css',
  'terminal-shell.css',
  'terminal-move.css',
  'settings.css',
  'harness-settings.css',
  'composer-submit.css',
  'terminal-list.css',
  'primitives.css',
  'workspace-state.css',
  'git-controls.css',
  'git-history.css',
  'git-graph.css',
  'git-inspector.css',
  'dialogs.css',
  'workspace-catalog.css',
  'tree.css',
  'file-operations.css',
  'path-copy.css',
  'viewer-content.css',
  'viewer-workload.css',
  'terminal-pane.css',
  'web-pane.css',
  'scrollbars.css',
] as const

describe('renderer style ownership', () => {
  it('declares one complete root-owned cascade order', () => {
    const root = process.cwd()
    const manifest = readFileSync(join(root, 'src/renderer/src/styles.css'), 'utf8')
    const imports = [...manifest.matchAll(/@import '\.\/styles\/([^']+)'/g)].map(
      (match) => match[1],
    )
    const files = readdirSync(join(root, 'src/renderer/src/styles'))
      .filter((file) => file.endsWith('.css'))
      .sort()

    expect(imports).toEqual(expectedOrder)
    expect([...imports].sort()).toEqual(files)
    expect(manifest).toContain('primitives.css is limited to pane resizers')
    expect(
      manifest
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/@import[^;]+;/g, '')
        .trim(),
    ).toBe('')
  })

  it('keeps scrollbar presentation in one cross-feature primitive', () => {
    const stylesRoot = join(process.cwd(), 'src/renderer/src/styles')
    const scrollbarOwners = readdirSync(stylesRoot)
      .filter((file) => file.endsWith('.css'))
      .filter((file) =>
        /scrollbar-(?:color|gutter|width)|::-(?:webkit-)?scrollbar/.test(
          readFileSync(join(stylesRoot, file), 'utf8'),
        ),
      )

    expect(scrollbarOwners).toEqual(['scrollbars.css'])
    const scrollbarPresentation = readFileSync(join(stylesRoot, 'scrollbars.css'), 'utf8')
    expect(scrollbarPresentation).toContain(
      'body:has(.hvir-scrollbar-obscuring) > .hvir-scrollbar.hvir-scrollbar',
    )
    expect(scrollbarPresentation).toContain('pointer-events: none')
  })

  it('routes renderer typography through the owned font and scale tokens', () => {
    const root = process.cwd()
    const styleRoot = join(root, 'src/renderer/src/styles')
    const styles = readdirSync(styleRoot)
      .filter((file) => file.endsWith('.css'))
      .map((file) => readFileSync(join(styleRoot, file), 'utf8'))
      .join('\n')
    const base = readFileSync(join(styleRoot, 'base.css'), 'utf8')
    const sourceView = readFileSync(
      join(root, 'src/renderer/src/viewer/FileViewer.tsx'),
      'utf8',
    )
    const diffView = readFileSync(
      join(root, 'src/renderer/src/viewer/DiffView.tsx'),
      'utf8',
    )

    expect(base).toContain('font-family: var(--hvir-interface-font)')
    expect(base).toContain('ui-sans-serif, system-ui')
    expect(base).toContain('ui-monospace')
    expect(styles).not.toMatch(/font-size:\s*[\d.]+px/u)
    expect(styles).not.toContain('JetBrains Mono')
    expect(styles).not.toContain('Inter,')
    expect(sourceView).toContain("fontFamily: 'var(--hvir-monospace-font)'")
    expect(sourceView).toContain('var(--hvir-interface-scale)')
    expect(diffView).toContain("fontFamily: 'var(--hvir-monospace-font)'")
    expect(diffView).toContain('var(--hvir-interface-scale)')
  })
})
