import { ESLint, Linter } from 'eslint'
import ts from 'typescript'
import tseslint from 'typescript-eslint'
import { afterEach, describe, expect, it } from 'vitest'
import { checkModuleDirections } from '../scripts/architecture-module-directions.mts'
import {
  collectModuleGraph,
  type ModuleGraph,
} from '../scripts/architecture-module-graph.mts'
import { moduleReferences } from '../scripts/architecture-module-resolution.mts'
import { collectInventory } from '../scripts/architecture-inventory.mts'
import { ordinaryPolicy, repository } from './fixtures/architecture/repository'

const root = process.cwd()
const eslint = new ESLint()
const linter = new Linter()
const fixtures: ReturnType<typeof repository>[] = []
afterEach(() => {
  for (const fixture of fixtures.splice(0)) fixture.dispose()
})

function graph(owner: string, target: string | undefined, source: string): ModuleGraph {
  const references = moduleReferences(
    ts.createSourceFile(owner, source, ts.ScriptTarget.Latest, true),
  )
  return {
    scope: { roots: [], configs: [], exclusions: [] },
    modules: target ? [owner, target] : [owner],
    edges: target
      ? references.map((ref) => ({
          ...ref,
          from: owner,
          to: target,
          kind: ref.erased ? 'type-only' : 'runtime',
        }))
      : [],
    loading: target
      ? []
      : references.map((ref) => ({ ...ref, from: owner, disposition: 'external' })),
    staticComponents: [],
    runtimeComponents: [],
    violations: [],
  }
}
async function originalMessages(owner: string, source: string) {
  const config = (await eslint.calculateConfigForFile(owner)) as Linter.Config
  return linter.verify(
    source,
    {
      files: ['**/*.{ts,tsx}'],
      languageOptions: { parser: tseslint.parser },
      plugins: config.plugins,
      rules: Object.fromEntries(
        Object.entries(config.rules ?? {}).filter(([name]) =>
          [
            'no-restricted-imports',
            'no-restricted-syntax',
            'smoke-ownership/inward',
          ].includes(name),
        ),
      ),
    },
    { filename: owner },
  )
}

describe('resolved adapter for existing dependency direction policy', () => {
  it.each([
    ['src/shared/diagnostics.ts', 'src/shared/ipc.ts', '../shared/ipc'],
    [
      'src/main/harness/harness-provider-contract.ts',
      'src/main/harness/providers/codex.ts',
      './providers/codex',
    ],
    [
      'src/main/pty/pty-stream-attachment.ts',
      'src/main/pty/pty-supervisor.ts',
      './pty-supervisor',
    ],
    [
      'src/renderer/src/viewer/highlight-protocol.ts',
      'src/renderer/src/viewer/SourceView.tsx',
      './SourceView',
    ],
    [
      'src/renderer/src/viewer/SourceView.tsx',
      'src/main/Harness/provider.ts',
      '../../../main/Harness/provider',
    ],
    ['src/main/smoke/viewer-content.ts', 'src/main/smoke/index.ts', './index'],
    [
      'src/main/harness/harness-provider.ts',
      'src/main/smoke/viewer-content.ts',
      '../smoke/viewer-content',
    ],
  ])(
    'preserves normal ESLint and resolves aliases for %s',
    async (owner, target, specifier) => {
      for (const form of [
        (path: string) => `import { Dependency } from '${path}'`,
        (path: string) => `import type { Dependency } from '${path}'`,
        (path: string) => `export type { Dependency } from '${path}'`,
        (path: string) => `type Dependency = import('${path}').Dependency`,
        (path: string) => `void import('${path}')`,
        (path: string) => `require('${path}')`,
      ]) {
        const original = form(specifier)
        // The old case-sensitive expression selector does not itself cover differently
        // cased harness spelling; the inherited static rule still owns that ban.
        if (!(specifier.includes('/Harness/') && /^(void|require|type)/.test(original)))
          expect(await originalMessages(owner, original)).not.toEqual([])
        expect(
          await checkModuleDirections(graph(owner, target, original), root),
          original,
        ).not.toEqual([])
        expect(
          await checkModuleDirections(
            graph(owner, target, form('@alias/Dependency')),
            root,
          ),
          original,
        ).not.toEqual([])
        expect(
          await checkModuleDirections(
            graph(owner.replace(/\.tsx?$/, '.mjs'), target, form('@alias/Dependency')),
            root,
          ),
          original,
        ).not.toEqual([])
      }
    },
  )

  it.each([
    [
      'src/main/diagnostics/diagnostic-evidence.ts',
      'src/main/diagnostics/diagnostic-intake.ts',
    ],
    [
      'src/main/diagnostics/diagnostic-intake.ts',
      'src/main/diagnostics/diagnostic-journal.ts',
    ],
    [
      'src/main/diagnostics/diagnostic-report-evidence.ts',
      'src/main/diagnostics/diagnostic-intake.ts',
    ],
    [
      'src/main/diagnostics/diagnostic-journal.ts',
      'src/main/diagnostics/diagnostic-report-evidence.ts',
    ],
    ['src/main/ipc/authority-port.ts', 'src/main/diagnostics/runtime-diagnostics.ts'],
    ['src/main/ipc/authority-router.ts', 'src/main/ipc/deps.ts'],
    ['src/main/diagnostics/runtime-diagnostics.ts', 'src/main/ipc/authority-router.ts'],
    [
      'src/renderer/src/viewer/viewer-read-policy.ts',
      'src/renderer/src/viewer/viewer-workspace-model.ts',
    ],
    [
      'src/renderer/src/viewer/viewer-path-rebind.ts',
      'src/renderer/src/viewer/viewer-workspace-model.ts',
    ],
    [
      'src/renderer/src/tree/use-path-copy-action.ts',
      'src/renderer/src/tree/use-file-create-actions.ts',
    ],
    [
      'src/renderer/src/tree/use-file-manager-reveal.ts',
      'src/renderer/src/tree/use-file-create-actions.ts',
    ],
    [
      'src/renderer/src/tree/file-action-menu.ts',
      'src/renderer/src/tree/use-file-manager-reveal.ts',
    ],
    [
      'src/renderer/src/tree/file-action-menu.ts',
      'src/renderer/src/tree/use-path-copy-action.ts',
    ],
    [
      'src/renderer/src/document-review/use-document-review-delivery.ts',
      'src/renderer/src/document-review/use-document-review-interaction.ts',
    ],
    [
      'src/renderer/src/document-review/document-review-workspace.ts',
      'src/renderer/src/document-review/document-review-workspace-controller.ts',
    ],
    [
      'scripts/project-management/github-agent-work-project.ts',
      'scripts/project-management/canonical-project.ts',
    ],
    [
      'scripts/project-management/canonical-project-item.ts',
      'scripts/project-management/github-agent-work-project.ts',
    ],
  ])(
    'blocks both runtime and erased ownership inversions from %s',
    async (owner, target) => {
      for (const source of [
        "import { Contract } from '@alias/owner'",
        "import type { Contract } from '@alias/owner'",
        "type Contract = import('@alias/owner').Contract",
        "const owner = require('@alias/owner')",
      ])
        expect(
          await checkModuleDirections(graph(owner, target, source), root),
        ).toContainEqual(expect.objectContaining({ from: owner, to: target, line: 1 }))
    },
  )

  it('preserves import-name restrictions without banning unrelated Electron types', async () => {
    const owner = 'src/main/ipc/feature.ts'
    for (const source of [
      "import { ipcRenderer } from 'electron'",
      "import type { ipcRenderer } from 'electron'",
      "export { ipcRenderer } from 'electron'",
      "type X = import('electron').ipcRenderer",
    ])
      expect(
        await checkModuleDirections(graph(owner, undefined, source), root),
      ).not.toEqual([])
    for (const source of [
      "import { ipcMain } from 'electron'",
      "import type { WebContents } from 'electron'",
      "type X = import('electron').WebContents",
    ])
      expect(await checkModuleDirections(graph(owner, undefined, source), root)).toEqual(
        [],
      )
  })

  it('allows only the exact dynamic smoke bootstrap and inward scenario composition', async () => {
    expect(
      await checkModuleDirections(
        graph(
          'src/main/index.mjs',
          'src/main/smoke/scenarios.ts',
          "void import('@alias/scenarios')",
        ),
        root,
      ),
    ).not.toEqual([])
    expect(
      await checkModuleDirections(
        graph(
          'src/main/index.ts',
          'src/main/smoke/scenarios.ts',
          "void import('@alias/scenarios')",
        ),
        root,
      ),
    ).toEqual([])
    expect(
      await checkModuleDirections(
        graph(
          'src/main/index.ts',
          'src/main/smoke/scenarios.ts',
          "import { run } from '@alias/scenarios'",
        ),
        root,
      ),
    ).not.toEqual([])
    expect(
      await checkModuleDirections(
        graph(
          'src/main/smoke/scenarios.ts',
          'src/main/smoke/index.ts',
          "import { run } from '@alias/root'",
        ),
        root,
      ),
    ).toEqual([])
    expect(
      await checkModuleDirections(
        graph(
          'src/main/smoke/fixture.ts',
          'src/main/smoke/index.d.ts',
          "import type { X } from '@alias/root'",
        ),
        root,
      ),
    ).not.toEqual([])
  })

  it('does not transfer exact native-host exemptions to alternate source paths', async () => {
    for (const owner of [
      'src/main/project-host/local-host.mjs',
      'src/main/project-host/local-host.d.ts',
      'src/main/project-host/local-host.cts',
    ])
      expect(
        await checkModuleDirections(
          graph(owner, undefined, "import fs from 'node:fs'"),
          root,
        ),
      ).not.toEqual([])
    expect(
      await checkModuleDirections(
        graph(
          'src/main/project-host/local-host.ts',
          undefined,
          "import fs from 'node:fs'",
        ),
        root,
      ),
    ).toEqual([])
    expect(
      await checkModuleDirections(
        graph(
          'src/preload/bridge.mjs',
          undefined,
          "import { ipcRenderer } from 'electron'",
        ),
        root,
      ),
    ).toEqual([])
    expect(
      await checkModuleDirections(
        graph('src/preload/bridge.mjs', undefined, "import fs from 'node:fs'"),
        root,
      ),
    ).not.toEqual([])
  })

  it('checks the resolved declaration name and retains case-sensitive viewer leaves', async () => {
    expect(
      await checkModuleDirections(
        graph(
          'src/renderer/src/viewer/SourceView.tsx',
          'src/renderer/src/viewer/FileViewer.d.ts',
          "import type { X } from '@alias/viewer'",
        ),
        root,
      ),
    ).not.toEqual([])
    expect(
      await checkModuleDirections(
        graph(
          'src/renderer/src/viewer/highlight-protocol.ts',
          'src/renderer/src/viewer/source-coordinate.ts',
          "import type { X } from './source-coordinate'",
        ),
        root,
      ),
    ).toEqual([])
  })

  it('enforces an actual configured type alias across JS maintained source', async () => {
    const repo = repository()
    fixtures.push(repo)
    repo.write(
      'tsconfig.base.json',
      JSON.stringify({
        compilerOptions: {
          module: 'ESNext',
          moduleResolution: 'Bundler',
          verbatimModuleSyntax: true,
          paths: { '@root': ['./src/main/smoke/index.d.ts'] },
        },
      }),
    )
    for (const environment of ['node', 'web'])
      repo.write(
        `tsconfig.${environment}.json`,
        JSON.stringify({ extends: './tsconfig.base.json' }),
      )
    repo.write('src/main/smoke/index.d.ts', 'export interface X {}')
    repo.write('src/main/smoke/fixture.mts', "type X = import('@root').X")
    const resolved = collectModuleGraph(
      repo.root,
      collectInventory(repo.root, ordinaryPolicy()),
      ordinaryPolicy(),
    )
    expect(resolved.violations).toEqual([])
    expect(await checkModuleDirections(resolved, root)).toContainEqual(
      expect.objectContaining({
        rule: 'smoke-ownership/inward',
        to: 'src/main/smoke/index.d.ts',
      }),
    )
  })

  it('fails malformed rules instead of accepting an empty effective policy', async () => {
    const repo = repository()
    fixtures.push(repo)
    repo.write(
      'eslint.config.mjs',
      "export default [{ files: ['**/*.ts'], rules: { 'no-restricted-imports': ['error', { malformed: true }] } }]",
    )
    await expect(
      checkModuleDirections(graph('src/a.ts', 'src/b.ts', "import './b'"), repo.root),
    ).rejects.toThrow()
  })

  it('applies maintained tooling suffixes without requiring an omitted lint extension', async () => {
    for (const owner of ['scripts/example.jsx', 'scripts/example.cts'])
      expect(
        await checkModuleDirections(
          graph(owner, 'scripts/leaf.ts', "import './leaf'"),
          root,
        ),
      ).toEqual([])
  })
})
