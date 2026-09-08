import { ESLint, Linter } from 'eslint'
import tseslint from 'typescript-eslint'
import { describe, expect, it } from 'vitest'

const eslint = new ESLint()
const linter = new Linter()

async function messages(owner: string, source: string) {
  const config = (await eslint.calculateConfigForFile(
    `src/renderer/src/viewer/${owner}`,
  )) as {
    rules: Record<string, Linter.RuleEntry>
  }
  return linter.verify(source, {
    languageOptions: { parser: tseslint.parser },
    rules: {
      'no-restricted-imports': config.rules['no-restricted-imports']!,
      'no-restricted-syntax': config.rules['no-restricted-syntax']!,
    },
  })
}

describe('viewer dependency direction', () => {
  it('preserves the inherited case-insensitive static harness import ban', async () => {
    for (const source of [
      "import { Dependency } from '../../../main/Harness/provider'",
      "import type { Dependency } from '../../../Main/harness/provider'",
      "export type { Dependency } from '../../../MAIN/HARNESS/provider'",
    ]) {
      expect(await messages('SourceView.tsx', source)).toEqual([
        expect.objectContaining({ severity: 2 }),
      ])
    }
  })
  it.each([
    ['SourceView.tsx', './FileViewer'],
    ['SourceView.tsx', '../../../main/harness/provider'],
    ['LargeFileView.tsx', './FileViewer'],
    ['highlight-request.ts', './FileViewer.tsx'],
    ['source-highlighting.ts', './FileViewer'],
    ['highlight-protocol.ts', './SourceView'],
    ['highlight-protocol.ts', './source-blame-gutter'],
    ['highlight-protocol.ts', '../../../main/project-host/local-host'],
    ['viewer-workload-policy.ts', '../../../preload/index'],
    ['viewer-position.ts', 'react'],
    ['temporary-document-tabs.ts', 'react'],
    ['temporary-document-tabs.ts', './viewer-workspace-model'],
    ['temporary-document-tabs.ts', './RenderedView'],
    ['source-coordinate.ts', './highlight-request'],
    ['highlight.worker.ts', './SourceView'],
    ['highlight.worker.ts', './source-highlighting'],
    ['highlight.worker.ts', './source-blame-gutter'],
  ])('rejects %s importing %s at runtime or as a type', async (owner, path) => {
    for (const source of [
      `import { Dependency } from '${path}'`,
      `import type { Dependency } from '${path}'`,
      `export type { Dependency } from '${path}'`,
      `type Dependency = import('${path}').Dependency`,
      `const dependency = import('${path}')`,
      `const dependency = require('${path}')`,
    ]) {
      expect(await messages(owner, source), source).toEqual([
        expect.objectContaining({ severity: 2 }),
      ])
    }
  })

  it.each([
    ['FileViewer.tsx', './SourceView'],
    ['SourceView.tsx', './source-highlighting'],
    ['highlight-request.ts', './highlight-protocol'],
    ['highlight.worker.ts', './highlight-protocol'],
    ['highlight.worker.ts', './shiki-grammar-registry'],
    ['viewer-position.ts', './tab-state'],
    ['temporary-document-tabs.ts', './tab-state'],
    ['viewer-workload-policy.ts', '../../../shared'],
  ])('admits %s importing its lower owner %s', async (owner, path) => {
    expect(await messages(owner, `import type { Contract } from '${path}'`)).toEqual([])
  })
})
