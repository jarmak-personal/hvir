import { describe, expect, it } from 'vitest'

import { defaultViewMode, localPath, renderedFileType } from '../src/shared'

describe('view mode inference', () => {
  it.each([
    ['README.md', 'markdown'],
    ['diagram.mmd', 'mermaid'],
    ['page.html', 'html'],
    ['data.json', 'json'],
    ['workflow.yml', 'yaml'],
    ['config.yaml', 'yaml'],
  ] as const)('opens %s rendered through the %s renderer', (name, renderer) => {
    const path = localPath(`/project/${name}`)
    expect(defaultViewMode(path)).toBe('rendered')
    expect(renderedFileType(path)).toBe(renderer)
  })

  it('opens ordinary source files in source mode', () => {
    expect(defaultViewMode(localPath('/project/App.tsx'))).toBe('source')
  })

  it('opens files from a git context directly in diff mode', () => {
    expect(defaultViewMode(localPath('/project/App.tsx'), 'git')).toBe('diff')
  })
})
