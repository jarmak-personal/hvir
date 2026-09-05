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

function references(path: string): readonly string[] {
  return [
    `import { Dependency } from '${path}'`,
    `import type { Dependency } from '${path}'`,
    `export { Dependency } from '${path}'`,
    `export type { Dependency } from '${path}'`,
    `type Dependency = import('${path}').Dependency`,
    `const dependency = import('${path}')`,
    `const dependency = require('${path}')`,
  ]
}

describe('harness provider dependency direction', () => {
  it.each([
    'harness-provider-contract',
    'harness-provider-registry',
    'harness-provider-capabilities',
    'harness-provider-probes',
    'harness-composer-contracts',
    'harness-launch-selection',
    'harness-usage',
    'harness-usage-demand-controller',
    'agent-work-usage',
    'harness-telemetry-hub',
  ])('keeps %s independent of bundled implementations', async (owner) => {
    for (const path of [
      './harness-provider',
      './harness-provider.ts',
      './bundled-harness-providers',
      './providers/codex',
      './providers/shell.ts',
      './claude-context-telemetry',
      './codex-session-discovery',
    ]) {
      for (const source of references(path)) {
        expect(await messages(`src/main/harness/${owner}.ts`, source), source).toEqual([
          expect.objectContaining({ severity: 2 }),
        ])
      }
    }
  })

  it('keeps provider implementations off the compatibility facade', async () => {
    for (const source of references('../harness-provider')) {
      expect(await messages('src/main/harness/providers/pi.ts', source)).toEqual([
        expect.objectContaining({ severity: 2 }),
      ])
    }
  })

  it.each(['src/shared/harness-telemetry.ts', 'src/renderer/src/App.tsx'])(
    'keeps %s provider-neutral',
    async (owner) => {
      for (const source of references('../main/harness/providers/codex')) {
        expect(await messages(owner, source)).toEqual([
          expect.objectContaining({ severity: 2 }),
        ])
      }
    },
  )

  it('admits inward contracts and explicit bundled composition', async () => {
    for (const [owner, path] of [
      ['harness-provider-contract', '../../shared/harness-provider'],
      ['harness-usage', './harness-provider-contract'],
      ['harness-usage-demand-controller', './harness-provider-registry'],
      ['providers/codex', '../harness-provider-contract'],
      ['providers/codex', '../codex-context-telemetry'],
      ['bundled-harness-providers', './providers/codex'],
      ['harness-provider', './bundled-harness-providers'],
    ]) {
      expect(
        await messages(
          `src/main/harness/${owner}.ts`,
          `import { Contract } from '${path}'`,
        ),
      ).toEqual([])
    }
  })
})
