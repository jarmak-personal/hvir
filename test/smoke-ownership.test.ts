import { ESLint, Linter } from 'eslint'
import tseslint from 'typescript-eslint'
import { describe, expect, it } from 'vitest'

const eslint = new ESLint()
const linter = new Linter()
async function messages(owner: string, source: string) {
  const config = (await eslint.calculateConfigForFile(owner)) as {
    plugins: NonNullable<Linter.Config['plugins']>
    rules: Record<string, Linter.RuleEntry>
  }
  return linter.verify(
    source,
    {
      files: ['**/*.{ts,tsx}'],
      languageOptions: { parser: tseslint.parser },
      plugins: config.plugins,
      rules: { 'smoke-ownership/inward': config.rules['smoke-ownership/inward']! },
    },
    { filename: owner },
  )
}

describe('smoke ownership direction', () => {
  it.each([
    ['src/main/smoke/viewer-content.ts', './index'],
    ['src/main/smoke/project-state-fixture.ts', '.'],
    ['src/main/smoke/nested/fixture.ts', '..'],
    ['src/main/smoke/nested/fixture.ts', '../index.ts'],
    ['src/main/harness/harness-provider.ts', '../smoke/viewer-content'],
    ['src/renderer/src/App.tsx', '../../main/smoke'],
    ['src/main/index.ts', './smoke/viewer-content'],
  ])('rejects %s importing %s through every static form', async (owner, target) => {
    for (const source of [
      `import { x } from '${target}'`,
      `import type { X } from '${target}'`,
      `export type { X } from '${target}'`,
      `type X = import('${target}').X`,
      `const x = import('${target}')`,
      `const x = require('${target}')`,
    ])
      expect(await messages(owner, source), source).toEqual([
        expect.objectContaining({ severity: 2 }),
      ])
  })
  it.each([
    ['src/main/index.ts', "const x = import('./smoke/scenarios')"],
    ['src/main/smoke/scenarios.ts', "import { runSmoke } from '.'"],
    [
      'src/main/smoke/viewer-content.ts',
      "import type { ProjectHost } from '../project-host'",
    ],
    ['src/main/smoke/index.ts', "import { verifyViewerContent } from './viewer-content'"],
  ])('admits the exact bootstrap and inward composition (%s)', async (owner, source) => {
    expect(await messages(owner, source)).toEqual([])
  })
})
