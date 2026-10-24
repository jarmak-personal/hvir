import { describe, expect, it } from 'vitest'

import {
  asHostId,
  defaultViewMode,
  hostPath,
  localPath,
  renderedFileType,
} from '../src/shared'

describe('view mode inference', () => {
  it.each([
    ['README.md', 'markdown'],
    ['diagram.mmd', 'mermaid'],
    ['page.html', 'html'],
    ['data.json', 'json'],
    ['events.jsonl', 'jsonl'],
    ['workflow.yml', 'yaml'],
    ['config.yaml', 'yaml'],
    ['report.csv', 'csv'],
    ['screenshot.png', 'image'],
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

  it('opens untracked git files with the normal rendered or source default', () => {
    expect(defaultViewMode(localPath('/project/notes.md'), 'git-untracked')).toBe(
      'rendered',
    )
    expect(defaultViewMode(localPath('/project/App.tsx'), 'git-untracked')).toBe('source')
  })
})

it('uses the same JSONL defaults for SSH and local files and preserves entry context', () => {
  const path = hostPath(asHostId('ssh:fixture'), '/project/events.JSONL')
  expect(renderedFileType(path)).toBe('jsonl')
  expect(defaultViewMode(path)).toBe('rendered')
  expect(defaultViewMode(path, 'git')).toBe('diff')
  expect(defaultViewMode(path, 'git-untracked')).toBe('rendered')
  expect(defaultViewMode(path, 'created-file')).toBe('source')
})
