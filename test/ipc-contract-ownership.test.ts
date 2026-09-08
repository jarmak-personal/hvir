import { ESLint, Linter } from 'eslint'
import tseslint from 'typescript-eslint'
import { describe, expect, it } from 'vitest'

const eslint = new ESLint()
const linter = new Linter()

async function messages(filePath: string, source: string) {
  const config = (await eslint.calculateConfigForFile(filePath)) as {
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

describe('shared capability contract direction', () => {
  it.each(['src/shared/sessions-projection.ts', 'src/shared/ipc/sessions.ts'])(
    'rejects transport and process imports from %s, including erased references',
    async (owner) => {
      for (const path of [
        './ipc',
        '../ipc',
        '../ipc.ts',
        './index',
        '../index',
        '../shared',
        '.',
        '..',
        '../main/harness/harness-provider',
        '../../preload/index',
        '../renderer/src/App',
        '../workers/git-worker',
        'electron',
      ]) {
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
      }
    },
  )

  it('admits shared leaves and the explicit aggregate composition', async () => {
    for (const path of ['../workspace-types', '../ipc-contract', '../harness-provider']) {
      expect(
        await messages(
          'src/shared/ipc/sessions.ts',
          `import type { Contract } from '${path}'`,
        ),
      ).toEqual([])
    }
    expect(
      await messages(
        'src/shared/sessions-projection.ts',
        "import type { ProjectState } from './workspace-types'",
      ),
    ).toEqual([])
    expect(
      await messages('src/shared/ipc.ts', "import { sessionsIpc } from './ipc/sessions'"),
    ).toEqual([])
  })
})
