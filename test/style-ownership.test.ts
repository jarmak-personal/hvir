import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

const expectedOrder = [
  'base.css',
  'projects.css',
  'shell.css',
  'viewer-tabs.css',
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
  'tree.css',
  'viewer-content.css',
  'terminal-pane.css',
  'web-pane.css',
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
})
