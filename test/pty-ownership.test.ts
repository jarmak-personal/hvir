import { ESLint, Linter } from 'eslint'
import tseslint from 'typescript-eslint'
import { describe, expect, it } from 'vitest'

const eslint = new ESLint()
const linter = new Linter()

async function messages(owner: string, source: string) {
  const config = (await eslint.calculateConfigForFile(`src/main/pty/${owner}.ts`)) as {
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

describe('PTY owner dependency direction', () => {
  it.each([
    'pty-contract',
    'pty-launch-admission',
    'pty-stream-attachment',
    'pty-session-observation',
    'pty-session-lifetime',
  ])('keeps %s inward and without spawning authority', async (owner) => {
    for (const path of [
      './pty-supervisor',
      './pty-supervisor.ts',
      './pty-session-lifetime',
      './pty-session-observation',
      './pty-stream-attachment',
      './pty-launch-admission',
      '../harness/harness-provider',
      '../harness/providers/codex',
    ]) {
      for (const source of [
        `import { Dependency } from '${path}'`,
        `import type { Dependency } from '${path}'`,
        `export type { Dependency } from '${path}'`,
        `type Dependency = import('${path}').Dependency`,
        `const dependency = import('${path}')`,
        `const dependency = require('${path}')`,
      ])
        expect(await messages(owner, source), source).toEqual([
          expect.objectContaining({ severity: 2 }),
        ])
    }
    for (const source of [
      'host.spawnPty({})',
      "const spawn = host['spawnPty']",
      "import pty from 'node-pty'",
      "const fs = import('node:fs')",
    ]) {
      expect(await messages(owner, source), source).toEqual([
        expect.objectContaining({ severity: 2 }),
      ])
    }
    for (const path of [
      './pty-contract',
      '../harness/harness-provider-contract',
      '../project-host/project-host',
      '../../shared/host-path',
    ]) {
      expect(await messages(owner, `import type { Contract } from '${path}'`)).toEqual([])
    }
  })

  it('keeps spawning and composition at the supervisor facade', async () => {
    expect(await messages('pty-supervisor', 'host.spawnPty({})')).toEqual([])
    expect(
      await messages(
        'pty-supervisor',
        "import { PtySessionLifetime } from './pty-session-lifetime'",
      ),
    ).toEqual([])
  })
})
