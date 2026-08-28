import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

const expectedOrder = [
  'base.css',
  'projects.css',
  'provider-context.css',
  'sessions-overview.css',
  'sessions-collection.css',
  'sessions-terminal-detail.css',
  'sessions-usage.css',
  'health.css',
  'diagnostic-report.css',
  'shell.css',
  'viewer-tabs.css',
  'viewer-find.css',
  'terminal-shell.css',
  'terminal-move.css',
  'settings.css',
  'terminal-theme-gallery.css',
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
  'context-menu.css',
  'file-operations.css',
  'path-copy.css',
  'terminal-context-menu.css',
  'viewer-content.css',
  'document-review.css',
  'viewer-workload.css',
  'terminal-pane.css',
  'terminal-search.css',
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

  it('bounds the project Working sweep and provides a static reduced-motion state', () => {
    const projects = readFileSync(
      join(process.cwd(), 'src/renderer/src/styles/projects.css'),
      'utf8',
    )

    expect(projects).toContain(
      'animation: project-name-working-sweep 6.5s linear infinite',
    )
    expect(projects).toContain('92.3076923077%,\n  100%')
    expect(projects).toContain('@media (prefers-reduced-motion: reduce)')
    expect(projects).toMatch(
      /@media \(prefers-reduced-motion: reduce\) \{[\s\S]*?\.project-name-working \{[\s\S]*?animation: none;[\s\S]*?text-decoration-style: dashed;[\s\S]*?\n {2}\}\n\}/u,
    )
  })

  it('keeps Usage movement bounded and provides the same static reduced-motion facts', () => {
    const usage = readFileSync(
      join(process.cwd(), 'src/renderer/src/styles/sessions-usage.css'),
      'utf8',
    )

    expect(usage).toContain('transition: width 220ms ease-out')
    expect(usage).not.toContain('animation:')
    expect(usage).toMatch(
      /@media \(prefers-reduced-motion: reduce\) \{[\s\S]*?\.sessions-usage-bar span \{[\s\S]*?transition: none;/u,
    )
  })

  it('bounds the Sessions detail reveal and disables it for reduced motion', () => {
    const detail = readFileSync(
      join(process.cwd(), 'src/renderer/src/styles/sessions-terminal-detail.css'),
      'utf8',
    )

    expect(detail).toContain(
      'animation: sessions-detail-reveal 280ms cubic-bezier(0.2, 0.8, 0.2, 1) both',
    )
    expect(detail).toContain(
      'animation: sessions-detail-panel-arrive 240ms 40ms ease-out both',
    )
    expect(detail).toMatch(
      /@media \(prefers-reduced-motion: reduce\) \{[\s\S]*?\.sessions-detail-backdrop,[\s\S]*?\.sessions-terminal-detail \{[\s\S]*?animation: none;/u,
    )
  })

  it('keeps Sessions workspace groups dense instead of stretching sparse columns', () => {
    const overview = readFileSync(
      join(process.cwd(), 'src/renderer/src/styles/sessions-overview.css'),
      'utf8',
    )

    expect(overview).toContain(
      'grid-template-columns: repeat(auto-fill, minmax(min(100%, 340px), 420px))',
    )
    expect(overview).toContain('justify-content: start')
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
