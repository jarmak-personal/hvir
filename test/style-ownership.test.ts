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
  'viewer-content.css',
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
  })
})
