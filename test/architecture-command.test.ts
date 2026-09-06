import console from 'node:console'
import process from 'node:process'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { runArchitectureCommand } from '../scripts/architecture-hotspots.mts'
import type { ModuleGraph } from '../scripts/architecture-module-graph.mts'
import type { ArchitectureRow } from '../scripts/architecture-policy.mts'
import {
  requireCurrentRemovalIssues,
  resolveArchitectureContext,
} from '../scripts/architecture-github.mts'
import { repository } from './fixtures/architecture/repository'

vi.mock('../scripts/architecture-github.mts', async (original) => ({
  ...(await original<typeof import('../scripts/architecture-github.mts')>()),
  resolveArchitectureContext: vi.fn(),
  requireCurrentRemovalIssues: vi.fn(),
}))

const fixtures: ReturnType<typeof repository>[] = []
const originalArgv = process.argv
const originalExitCode = process.exitCode
interface CommandReport {
  mode: string
  admission: { kind: string }
  violations: ArchitectureRow[]
  dependencies: ModuleGraph
}
afterEach(() => {
  process.argv = originalArgv
  process.exitCode = originalExitCode
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
  for (const fixture of fixtures.splice(0)) fixture.dispose()
})

function fixture() {
  const repo = repository()
  fixtures.push(repo)
  repo.write(
    'tsconfig.base.json',
    JSON.stringify({
      compilerOptions: {
        target: 'ES2022',
        module: 'ESNext',
        moduleResolution: 'Bundler',
        isolatedModules: true,
        verbatimModuleSyntax: true,
      },
    }),
  )
  for (const name of ['node', 'web'])
    repo.write(`tsconfig.${name}.json`, '{"extends":"./tsconfig.base.json"}')
  repo.write(
    'eslint.config.mjs',
    `export default [{files: ['**/*.{ts,js,mjs}'], rules: {
      'no-restricted-imports': ['error', {patterns: ['./forbidden']}]
    }}]`,
  )
  vi.stubEnv('HVIR_REPO_TOKEN', 'fixture-token')
  vi.mocked(resolveArchitectureContext).mockImplementation(() =>
    Promise.resolve({
      kind: 'ordinary',
      target: 'main',
      epic: null,
      base: repo.initial,
      head: repo.git('rev-parse', 'HEAD'),
    }),
  )
  vi.mocked(requireCurrentRemovalIssues).mockResolvedValue(undefined)
  return repo
}

async function run(repo: ReturnType<typeof repository>, ...args: string[]) {
  process.argv = ['node', 'architecture-hotspots.mjs', ...args]
  process.exitCode = 0
  const output = vi.spyOn(console, 'log').mockImplementation(() => {})
  const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
  await runArchitectureCommand(repo.root)
  const result = {
    output: output.mock.calls.map(([line]) => String(line)).join('\n'),
    errors: errors.mock.calls.map(([line]) => String(line)).join('\n'),
    exitCode: process.exitCode,
  }
  output.mockRestore()
  errors.mockRestore()
  return result
}

describe('architecture command composition', () => {
  it('reports scope, loading, components and exact edge kinds without serializing internal inputs', async () => {
    const repo = fixture()
    repo.write('src/a.ts', "import type { B } from './b'; export interface A { b: B }")
    repo.write('src/b.ts', "export interface B { a: import('./a').A }")
    repo.write('scripts/self.mjs', "import './self.mjs'")
    repo.write('src/launcher.ts', "utilityProcess.fork('./entry.ts')")
    repo.write('src/entry.ts', 'export {}')
    const text = await run(repo)
    expect(text.exitCode).toBe(0) // Provisional reporting is not enforcement.
    expect(text.errors).toBe('')
    expect(text.output).toContain('architecture budgets (provisional-report)')
    expect(text.output).toContain(
      'roots: src, test, scripts, packages, build, .github, .githooks, .agents, .claude, (repository root files)',
    )
    expect(text.output).toContain(
      'resolution: tsconfig.base.json, tsconfig.node.json, tsconfig.web.json',
    )
    expect(text.output).toContain('Installed dependencies and builtins are external')
    expect(text.output).toContain('Git internals and disposable output')
    expect(text.output).toContain('Non-code assets and exact native build output')
    expect(text.output).toContain('outside same-module cycle proof')
    expect(text.output).toContain('1 runtime cycle(s); 2 static component(s)')
    expect(text.output).toContain('component: src/a.ts, src/b.ts')
    expect(text.output).toContain('src/a.ts:1 --type-only/import--> src/b.ts')
    expect(text.output).toContain('src/b.ts:1 --type-only/import-type--> src/a.ts')
    expect(text.output).toContain(
      'scripts/self.mjs:1 --runtime/import--> scripts/self.mjs',
    )
    expect(text.output).toContain(
      'loading: src/launcher.ts:1 utility-process process-entry -> src/entry.ts',
    )
    expect(text.output).toContain('! runtime-cycle: : scripts/self.mjs')
    expect(text.output).toContain('1 dependency violation(s)')
    const json = JSON.parse((await run(repo, '--json')).output) as CommandReport
    expect(json).not.toHaveProperty('policy')
    expect(json).not.toHaveProperty('inventory')
    expect(json.dependencies.staticComponents).toEqual([
      ['scripts/self.mjs'],
      ['src/a.ts', 'src/b.ts'],
    ])
    expect(json.dependencies.edges).toHaveLength(3)
  })

  it.each(['runtime', 'direction', 'process-direction', 'budget'])(
    'fails enforcement for a collected %s violation',
    async (violation) => {
      const repo = fixture()
      if (violation === 'runtime') repo.write('src/owner.ts', "import './owner'")
      else if (violation === 'budget') repo.source(1001)
      else {
        repo.write('src/forbidden.ts', 'export interface Value {}')
        repo.write(
          'src/owner.ts',
          violation === 'direction'
            ? "import type { Value } from './forbidden'"
            : "utilityProcess.fork('./forbidden.ts')",
        )
      }
      const result = await run(repo, '--enforce', '--json')
      expect(result.exitCode).toBe(1)
      expect(result.errors).toBe('')
      const report = JSON.parse(result.output) as CommandReport
      expect(report.mode).toBe('enforce')
      expect(report.admission.kind).toBe('accepted-policy')
      expect(report).not.toHaveProperty('policy')
      expect(report).not.toHaveProperty('inventory')
      if (violation === 'budget') expect(report.violations).toHaveLength(1)
      else {
        expect(report.violations).toEqual([])
        expect(report.dependencies.violations).toContainEqual(
          expect.objectContaining({
            rule: violation === 'runtime' ? 'runtime-cycle' : 'no-restricted-imports',
          }),
        )
      }
      if (violation === 'process-direction') {
        expect(report.dependencies.edges).toEqual([])
        expect(report.dependencies.runtimeComponents).toEqual([])
      }
    },
  )

  it('passes enforcement with clean budgets and module directions', async () => {
    const repo = fixture()
    repo.write('src/owner.ts', 'export const value = 1')
    const result = await run(repo, '--enforce')
    expect(result.exitCode).toBe(0)
    expect(result.errors).toBe('')
    expect(result.output).toContain('0 budget violation(s)')
    expect(result.output).toContain('0 dependency violation(s)')
  })

  it('fails visibly when a required resolution configuration is missing', async () => {
    const repo = fixture()
    repo.remove('tsconfig.web.json')
    const result = await run(repo, '--enforce')
    expect(result.exitCode).toBe(1)
    expect(result.output).toBe('')
    expect(result.errors).toContain(
      'Architecture verification failed: Missing required resolution input',
    )
  })
})
