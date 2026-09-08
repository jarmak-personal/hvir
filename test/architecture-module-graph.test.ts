import { symlinkSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { collectInventory } from '../scripts/architecture-inventory.mts'
import { collectModuleGraph } from '../scripts/architecture-module-graph.mts'
import { ordinaryPolicy, repository } from './fixtures/architecture/repository'

const fixtures: ReturnType<typeof repository>[] = []
afterEach(() => {
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
        paths: { '@owner/*': ['./src/*'] },
      },
    }),
  )
  for (const config of ['node', 'web'])
    repo.write(
      `tsconfig.${config}.json`,
      JSON.stringify({ extends: './tsconfig.base.json', include: ['src/**/*'] }),
    )
  return {
    ...repo,
    graph: () =>
      collectModuleGraph(
        repo.root,
        collectInventory(repo.root, ordinaryPolicy()),
        ordinaryPolicy(),
      ),
  }
}

describe('maintained module graph', () => {
  it('includes every maintained TS/JS and declaration suffix', () => {
    const repo = fixture()
    repo.write('src/leaf.ts', 'export const value = 1')
    const suffixes = [
      'ts',
      'tsx',
      'mts',
      'cts',
      'js',
      'jsx',
      'mjs',
      'cjs',
      'd.ts',
      'd.mts',
      'd.cts',
    ]
    for (const suffix of suffixes) repo.write(`src/owner.${suffix}`, "import './leaf'")
    const graph = repo.graph()
    expect(graph.modules).toHaveLength(suffixes.length + 1)
    expect(graph.edges).toHaveLength(suffixes.length)
    expect(
      graph.edges.filter((edge) => edge.kind === 'type-only').map((edge) => edge.from),
    ).toEqual(['src/owner.d.cts', 'src/owner.d.mts', 'src/owner.d.ts'])
    expect(graph.violations).toEqual([])
  })

  it('blocks executable components and singleton self-loops with deterministic paths', () => {
    const repo = fixture()
    repo.write('src/a.ts', "import { b } from './b'; export const a = b")
    repo.write('src/b.ts', "export { a as b } from './a'")
    repo.write('scripts/self.mjs', "import './self.mjs'")
    const graph = repo.graph()
    expect(graph.runtimeComponents).toEqual([
      ['scripts/self.mjs'],
      ['src/a.ts', 'src/b.ts'],
    ])
    expect(graph.violations.map((value) => value.rule)).toEqual([
      'runtime-cycle',
      'runtime-cycle',
    ])
    expect(repo.graph()).toEqual(graph)
  })

  it('retains coherent erased relationships without banning static cycles', () => {
    const repo = fixture()
    repo.write('src/a.ts', "import type { B } from './b'; export interface A { peer: B }")
    repo.write('src/b.ts', "export interface B { peer: import('./a').A }")
    expect(repo.graph()).toMatchObject({
      staticComponents: [['src/a.ts', 'src/b.ts']],
      runtimeComponents: [],
      violations: [],
    })
    expect(repo.graph().edges.map((edge) => [edge.form, edge.kind])).toEqual([
      ['import', 'type-only'],
      ['import-type', 'type-only'],
    ])
  })

  it('uses emission for mixed and inline-only imports, erased exports and declarations', () => {
    const repo = fixture()
    repo.write('src/leaf.ts', 'export interface T {}; export const value = 1')
    repo.write(
      'src/mixed.ts',
      "import { value, type T } from './leaf'; export {value}; export type { T } from './leaf'",
    )
    repo.write('src/inline.ts', "import { type T } from './leaf'")
    repo.write('src/erased.ts', "import type { T } from './leaf'")
    repo.write(
      'src/declaration.d.ts',
      "import { value } from './leaf'; export type Value = typeof value",
    )
    const edges = repo.graph().edges
    expect(edges.map((edge) => [edge.from, edge.form, edge.kind])).toEqual([
      ['src/declaration.d.ts', 'import', 'type-only'],
      ['src/erased.ts', 'import', 'type-only'],
      ['src/inline.ts', 'import', 'runtime'],
      ['src/mixed.ts', 'import', 'runtime'],
      ['src/mixed.ts', 'export', 'type-only'],
    ])
    // verbatimModuleSyntax keeps `import {} from './leaf'`, including side effects.
    repo.write(
      'tsconfig.node.json',
      JSON.stringify({
        extends: './tsconfig.base.json',
        compilerOptions: { verbatimModuleSyntax: false },
        include: ['src/**/*'],
      }),
    )
    expect(repo.graph().edges.find((edge) => edge.from === 'src/inline.ts')?.kind).toBe(
      'type-only',
    )
  })

  it('resolves aliases, reexports, literal dynamic imports, require and import-equals', () => {
    const repo = fixture()
    repo.write(
      'tsconfig.node.json',
      JSON.stringify({
        extends: './tsconfig.base.json',
        compilerOptions: { module: 'Preserve' },
        include: ['src/**/*'],
      }),
    )
    repo.write('src/leaf.ts', 'export const value = 1')
    repo.write('src/barrel.ts', "export * from '@owner/leaf'")
    repo.write(
      'src/client.ts',
      "const a = import('@owner/barrel'); const b = require('./leaf'); import c = require('./leaf'); export { a, b, c }",
    )
    const graph = repo.graph()
    expect(graph.violations).toEqual([])
    expect(graph.edges.map((edge) => [edge.from, edge.to, edge.form])).toEqual([
      ['src/barrel.ts', 'src/leaf.ts', 'export'],
      ['src/client.ts', 'src/barrel.ts', 'dynamic-import'],
      ['src/client.ts', 'src/leaf.ts', 'require'],
      ['src/client.ts', 'src/leaf.ts', 'import-equals'],
    ])
    expect(
      graph.edges
        .filter((edge) => edge.form === 'dynamic-import' || edge.form === 'require')
        .every((edge) => edge.kind === 'runtime'),
    ).toBe(true)
  })

  it('does not attribute another require call to an erased import-equals declaration', () => {
    const repo = fixture()
    repo.write('src/leaf.ts', 'export const value = 1')
    repo.write(
      'src/client.ts',
      "import owner = require('./leaf'); require('./leaf'); console.log(owner)",
    )
    expect(repo.graph().edges.map((edge) => [edge.form, edge.kind])).toEqual([
      ['import-equals', 'type-only'],
      ['require', 'runtime'],
    ])
  })

  it('keeps the actual mjs implementation beside its declaration companion', () => {
    const repo = fixture()
    repo.write(
      'scripts/client.mts',
      "import { value } from './release-changelog.mjs'; export {value}",
    )
    repo.write('scripts/release-changelog.d.mts', 'export declare const value: number')
    repo.write(
      'scripts/release-changelog.mjs',
      "import './client.mts'; export const value = 1",
    )
    const graph = repo.graph()
    expect(
      graph.edges
        .filter((edge) => edge.from === 'scripts/client.mts')
        .map((edge) => [edge.to, edge.kind]),
    ).toEqual([
      ['scripts/release-changelog.d.mts', 'type-only'],
      ['scripts/release-changelog.mjs', 'runtime'],
    ])
    expect(graph.runtimeComponents).toEqual([
      ['scripts/client.mts', 'scripts/release-changelog.mjs'],
    ])
    repo.remove('scripts/release-changelog.mjs')
    expect(repo.graph().violations).toContainEqual(
      expect.objectContaining({ rule: 'missing-runtime-implementation' }),
    )
  })

  it('reports process entrypoints, existing assets and nonliteral/discovery loading separately', () => {
    const repo = fixture()
    repo.write(
      'src/owner.ts',
      "import './style.css'; import data from './data.json'; new Worker(new URL('./parse.worker.ts', import.meta.url)); import(data.module); require(data.module); new Worker(data.worker); import.meta.glob('./*.ts')",
    )
    repo.write('src/style.css', ':root {}')
    repo.write('src/data.json', '{}')
    repo.write('src/parse.worker.ts', "import './owner'")
    const graph = repo.graph()
    expect(graph.loading.map((entry) => [entry.form, entry.disposition])).toEqual([
      ['import', 'asset'],
      ['import', 'asset'],
      ['worker', 'process-entry'],
      ['dynamic-import', 'nonliteral'],
      ['require', 'nonliteral'],
      ['worker', 'nonliteral'],
      ['discovery', 'discovery'],
    ])
    expect(graph.runtimeComponents).toEqual([])
    expect(graph.violations).toEqual([])
  })

  it('recognizes only the exact native build output and requires its maintained inputs', () => {
    const repo = fixture()
    repo.write(
      'packages/rename-noreplace/index.js',
      "module.exports = require('./build/Release/rename_noreplace.node')",
    )
    repo.write('packages/rename-noreplace/binding.gyp', '{}')
    repo.write('packages/rename-noreplace/rename_noreplace.c', '// native owner')
    expect(repo.graph().loading).toContainEqual(
      expect.objectContaining({ disposition: 'native-build-output' }),
    )
    repo.remove('packages/rename-noreplace/binding.gyp')
    expect(() => repo.graph()).toThrow('Missing required native build input')
  })

  it('follows createRequire bindings and exposes Vite and utility-process loading', () => {
    const repo = fixture()
    repo.write('src/leaf.ts', 'export const value = 1')
    repo.write('scripts/runner.mts', 'export const value = 1')
    repo.write(
      'src/owner.ts',
      "import {createRequire as makeRequire} from 'node:module'; const load = makeRequire(import.meta.url); load('./leaf'); makeRequire(import.meta.url)('./leaf'); load.resolve('./leaf'); server.ssrLoadModule('/scripts/runner.mts'); utilityProcess.fork(entryPath)",
    )
    const graph = repo.graph()
    expect(graph.edges.map((edge) => [edge.to, edge.form, edge.kind])).toEqual([
      ['src/leaf.ts', 'require', 'runtime'],
      ['src/leaf.ts', 'require', 'runtime'],
    ])
    expect(
      graph.loading
        .filter((entry) => entry.disposition !== 'external')
        .map((entry) => [entry.form, entry.disposition, entry.target]),
    ).toEqual([
      ['discovery', 'discovery', undefined],
      ['module-runner', 'discovery', 'scripts/runner.mts'],
      ['utility-process', 'nonliteral', undefined],
    ])
    expect(graph.violations).toEqual([])
  })

  it('fails unresolved internal/alias/asset paths, directories and arbitrary escaped source', () => {
    const repo = fixture()
    repo.write(
      'src/owner.ts',
      "import './missing'; import '@owner/absent'; import './missing.css'; import './directory'; import '../../escaped.ts'",
    )
    repo.write('src/directory/data.json', '{}')
    expect(repo.graph().violations.map((value) => value.rule)).toEqual(
      Array(5).fill('unresolved-internal'),
    )
    // An existing source file outside the repository is not an installed dependency.
    const outside = fixture()
    outside.write('src/external.ts', 'export const value = 1')
    repo.write(
      'src/owner.ts',
      `import ${JSON.stringify(join(outside.root, 'src/external.ts'))}`,
    )
    expect(repo.graph().violations).toContainEqual(
      expect.objectContaining({ rule: 'unclassified-internal' }),
    )
  })

  it.each(['worker', 'utility-process'] as const)(
    'resolves literal %s implementation entries without inventing module cycles',
    (form) => {
      const repo = fixture()
      const load = (target: string) =>
        form === 'worker'
          ? `new Worker(new URL('${target}', import.meta.url))`
          : `utilityProcess.fork('${target}')`
      repo.write('src/owner.ts', load('./entry.mjs'))
      repo.write('src/entry.d.mts', 'export declare const value: number')
      repo.write('src/entry.mjs', "import './owner'; export const value = 1")
      const graph = repo.graph()
      expect(graph.loading).toContainEqual(
        expect.objectContaining({
          from: 'src/owner.ts',
          form,
          target: 'src/entry.mjs',
          disposition: 'process-entry',
        }),
      )
      expect(graph.edges.map((edge) => [edge.from, edge.to])).toEqual([
        ['src/entry.mjs', 'src/owner.ts'],
      ])
      expect(graph.runtimeComponents).toEqual([])
      expect(graph.violations).toEqual([])

      repo.remove('src/entry.mjs')
      expect(repo.graph().violations).toContainEqual(
        expect.objectContaining({ rule: 'unresolved-process-entry' }),
      )
      const outside = fixture()
      outside.write('src/entry.ts', 'export const value = 1')
      repo.write('src/owner.ts', load(join(outside.root, 'src/entry.ts')))
      expect(repo.graph().violations).toContainEqual(
        expect.objectContaining({
          rule: 'unclassified-process-entry',
        }),
      )
      expect(repo.graph().violations[0]?.to).toContain('/src/entry.ts')
      repo.write('src/owner.ts', load('./missing.ts'))
      expect(repo.graph().violations).toContainEqual(
        expect.objectContaining({
          rule: 'unresolved-process-entry',
          to: 'src/missing.ts',
        }),
      )
    },
  )

  it('fails missing and malformed configuration and syntax', () => {
    const repo = fixture()
    repo.write('src/owner.ts', 'export const =')
    expect(() => repo.graph()).toThrow('Malformed module input')
    repo.write('tsconfig.node.json', '{broken')
    expect(() => repo.graph()).toThrow()
    repo.remove('tsconfig.web.json')
    repo.write('tsconfig.node.json', '{}')
    expect(() => repo.graph()).toThrow('Missing required resolution input')
  })

  it('covers added files across maintained roots and canonicalizes owned symlink aliases once', () => {
    const repo = fixture()
    for (const path of [
      'root.mjs',
      'src/a.ts',
      'test/a.ts',
      'scripts/a.cts',
      'packages/a.js',
      'build/a.mjs',
      '.github/a.mjs',
      '.githooks/a.js',
      '.claude/skill/a.mjs',
    ])
      repo.write(path, 'export const value = 1')
    repo.commit()
    symlinkSync('.claude', join(repo.root, '.agents'))
    repo.write('src/added.ts', "import '../.agents/skill/a.mjs'")
    const graph = repo.graph()
    expect(graph.modules).toHaveLength(10)
    expect(graph.edges).toContainEqual(
      expect.objectContaining({ from: 'src/added.ts', to: '.claude/skill/a.mjs' }),
    )
    expect(graph.violations).toEqual([])
  })
})
