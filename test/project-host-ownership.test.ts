import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { ESLint, Linter } from 'eslint'
import tseslint from 'typescript-eslint'
import { afterAll, describe, expect, it } from 'vitest'

const eslint = new ESLint()
const linter = new Linter()

async function importMessages(filePath: string, source: string) {
  const config = (await eslint.calculateConfigForFile(filePath)) as {
    rules: Record<string, Linter.RuleEntry>
  }
  return linter.verify(source, {
    languageOptions: { parser: tseslint.parser },
    rules: { 'no-restricted-imports': config.rules['no-restricted-imports']! },
  })
}

describe('project state and host ownership imports', () => {
  it.each(['', 'type '])(
    'rejects concrete owners in %simports without a type-only escape',
    async (kind) => {
      for (const owner of ['project-registry', 'project-coordinator']) {
        for (const dependency of [
          './project-host',
          './project-host/index',
          './project-host/project-host-catalog',
          './project-host/ssh-host',
          './project-host/ssh-host-trust',
          './project-host/ssh-auth',
          './project-host/ssh-identity-source',
          './project-host/ssh-transport-pool',
          './project-host/renderer-ssh-prompter',
        ]) {
          const messages = await importMessages(
            `src/main/${owner}.ts`,
            `import ${kind}{ Concrete } from '${dependency}'`,
          )
          expect(messages, `${owner}: ${dependency}`).toEqual([
            expect.objectContaining({ ruleId: 'no-restricted-imports', severity: 2 }),
          ])
        }
      }
      for (const owner of ['project-host-catalog', 'project-host']) {
        for (const dependency of ['../project-registry', '../project-coordinator']) {
          expect(
            await importMessages(
              `src/main/project-host/${owner}.ts`,
              `import ${kind}{ Concrete } from '${dependency}'`,
            ),
          ).toEqual([
            expect.objectContaining({ ruleId: 'no-restricted-imports', severity: 2 }),
          ])
        }
      }
      for (const dependency of ['./ssh-host', './project-host-catalog', './local-host']) {
        expect(
          await importMessages(
            'src/main/project-host/project-host.ts',
            `import ${kind}{ Concrete } from '${dependency}'`,
          ),
        ).toEqual([
          expect.objectContaining({ ruleId: 'no-restricted-imports', severity: 2 }),
        ])
      }
    },
  )

  it('admits narrow host contracts and catalog-owned concrete composition', async () => {
    expect(
      await importMessages(
        'src/main/project-registry.ts',
        "import type { ProjectHost } from './project-host/project-host'",
      ),
    ).toEqual([])
    expect(
      await importMessages(
        'src/main/project-coordinator.ts',
        "import type { ProjectHost } from './project-host/project-host'",
      ),
    ).toEqual([])
    expect(
      await importMessages(
        'src/main/project-host/project-host-catalog.ts',
        "import { SshHost } from './ssh-host'",
      ),
    ).toEqual([])
  })
})

const root = mkdtempSync(join(tmpdir(), 'hvir-host-ownership-'))
afterAll(() => rmSync(root, { recursive: true, force: true }))
const script = resolve('scripts/check-seams.sh')
function source(path: string, contents = '') {
  const file = join(root, 'src', path)
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, contents)
}
for (const path of [
  'main/project-registry.ts',
  'main/project-coordinator.ts',
  'main/project-host/index.ts',
  'main/project-host/project-host-catalog.ts',
  'main/project-host/project-host.ts',
  'main/git/git-command-context.ts',
  'main/ipc/features/project.ts',
  'workers/git-worker.ts',
  ...[
    'client-lifecycle',
    'file-access',
    'exclusive-create',
    'project-file-transfer',
    'transport-pool',
    'watch-service',
  ].map((name) => `main/project-host/ssh-${name}.ts`),
])
  source(path)

describe('registry host-facade seam backstop', () => {
  it('allows the registry consumer lookup port without publishing a host facade', () => {
    source(
      'main/project-registry.ts',
      'export interface ProjectRegistryHostCatalog {\n  hostById(hostId: string): ProjectHost | undefined\n}\nexport class ProjectRegistry {}\n',
    )
    expect(spawnSync('bash', [script], { cwd: root, encoding: 'utf8' }).status).toBe(0)
  })

  it.each([
    'listHosts',
    'hostById',
    'connectedHosts',
    'connectHost',
    'disconnectHost',
    'disconnectSshHosts',
    'browseHost',
  ])('rejects a restored %s registry facade', (method) => {
    source(
      'main/project-registry.ts',
      `export class ProjectRegistry {\n  async ${method}() {}\n}\n`,
    )
    const result = spawnSync('bash', [script], { cwd: root, encoding: 'utf8' })
    expect(result.status).toBe(1)
    expect(result.stdout).toContain(
      'SSH construction and implementation owners stay in the host catalog',
    )
  })
})
