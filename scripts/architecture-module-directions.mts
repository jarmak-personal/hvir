import { dirname, relative, resolve } from 'node:path'
import { ESLint, Linter } from 'eslint'
import tseslint from 'typescript-eslint'
import type { ModuleReference } from './architecture-module-resolution.mts'
import type { GraphViolation, ModuleGraph } from './architecture-module-graph.mts'

/** Adapt resolved edges to the existing ESLint policy, without a second ban table. */
export async function checkModuleDirections(
  graph: ModuleGraph,
  configurationRoot: string,
): Promise<GraphViolation[]> {
  const eslint = new ESLint({ cwd: configurationRoot })
  const linter = new Linter({ cwd: configurationRoot })
  const violations: GraphViolation[] = []
  for (const from of graph.modules) {
    const refs = [
      ...graph.edges
        .filter((edge) => edge.from === from)
        .map((edge) => ({ ...edge, target: edge.to })),
      ...graph.loading.filter((entry) => entry.from === from),
    ].filter((ref) => ref.specifier !== undefined)
    if (!refs.length) continue
    // Owner selection is independent of the TS/JS suffix. JS and declaration files
    // have the same inward dependencies as the corresponding existing TS owner.
    const policyPath =
      from.startsWith('src/') || from.startsWith('scripts/project-management/')
        ? from
            .replace(/\.d(?=\.[cm]?ts$)/, '')
            .replace(/\.[cm]?[jt]sx?$/, from.endsWith('x') ? '.tsx' : '.ts')
        : from.replace(/\.jsx$/, '.js').replace(/\.cts$/, '.mts')
    const policyPaths = new Set([from, policyPath])
    if (from !== policyPath) {
      // Retain directory policy while avoiding an exact file's positive exemption:
      // local-host.mjs is not local-host.ts; preload's directory seam stays intact.
      policyPaths.add(from.replace(/\.[cm]?[jt]sx?$/, '.architecture-import-policy.ts'))
    }
    const lines: string[] = []
    const expressions: string[] = []
    const origins: typeof refs = []
    for (const ref of refs) {
      const canonical = ref.target
        ? relative(dirname(from), ref.target)
            .replaceAll('\\', '/')
            .replace(/\.d(?=\.[cm]?ts$)/, '')
            .replace(/\.[cm]?[jt]sx?$/, '')
        : undefined
      const specifiers = new Set([
        ref.specifier!,
        ...(canonical ? [canonical.startsWith('.') ? canonical : `./${canonical}`] : []),
      ])
      for (const specifier of specifiers) {
        // Check static source/name bans for every form, then preserve the actual
        // expression form for the existing dynamic/import-type/require selectors.
        lines.push(importProbe(ref, specifier))
        origins.push(ref)
        expressions.push(expressionProbe(ref, specifier) ?? importProbe(ref, specifier))
      }
    }
    for (const selectedPath of policyPaths) {
      const config = (await eslint.calculateConfigForFile(
        resolve(configurationRoot, selectedPath),
      )) as Linter.Config | undefined
      if (!config) {
        if (selectedPath === policyPath)
          throw new Error(`Missing dependency rule configuration: ${from}`)
        continue
      }
      const rules = Object.fromEntries(
        Object.entries(config.rules ?? {}).filter(([name]) =>
          [
            'no-restricted-imports',
            'no-restricted-syntax',
            'smoke-ownership/inward',
          ].includes(name),
        ),
      )
      const probeConfig: Linter.Config = {
        files: ['**/*.{ts,tsx,mts,cts,js,jsx,mjs,cjs}'],
        languageOptions: {
          parser: tseslint.parser,
          parserOptions: { ecmaVersion: 'latest', sourceType: 'module' },
        },
        plugins: config.plugins,
      }
      const messages = [
        ...linter.verify(
          lines.join('\n'),
          {
            ...probeConfig,
            rules: { 'no-restricted-imports': rules['no-restricted-imports'] ?? 'off' },
          },
          { filename: resolve(configurationRoot, from) },
        ),
        ...linter.verify(
          expressions.join('\n'),
          {
            ...probeConfig,
            rules: Object.fromEntries(
              Object.entries(rules).filter(([name]) => name !== 'no-restricted-imports'),
            ),
          },
          { filename: resolve(configurationRoot, from) },
        ),
      ]
      for (const message of messages) {
        if (message.fatal || !message.ruleId)
          throw new Error(`Malformed dependency rule/probe: ${from}: ${message.message}`)
        const ref = origins[message.line - 1]!
        violations.push({
          rule: message.ruleId,
          from,
          to: ref.target ?? ref.specifier,
          line: ref.line,
          detail: message.message,
        })
      }
    }
  }
  return [...new Map(violations.map((value) => [JSON.stringify(value), value])).values()]
}

function importProbe(ref: ModuleReference, specifier: string): string {
  const source = JSON.stringify(specifier)
  // Runtime namespace discovery does not by itself access any particular name.
  // Keep name-sensitive restrictions faithful to the original import/type syntax.
  if (
    [
      'dynamic-import',
      'require',
      'worker',
      'discovery',
      'module-runner',
      'utility-process',
    ].includes(ref.form)
  )
    return `import Dependency from ${source};`
  if (ref.names.includes('*')) return `import * as Dependency from ${source};`
  if (!ref.names.length) return `import ${source};`
  const names = ref.names
    .map((name, index) => `${JSON.stringify(name)} as Dependency${index}`)
    .join(', ')
  return `import ${ref.erased ? 'type ' : ''}{ ${names} } from ${source};`
}
function expressionProbe(ref: ModuleReference, specifier: string): string | undefined {
  const source = JSON.stringify(specifier)
  switch (ref.form) {
    case 'dynamic-import':
      return `void import(${source});`
    case 'import-type':
      return `type Dependency = import(${source});`
    case 'require':
    case 'import-equals':
      return `require(${source});`
    default:
      return undefined
  }
}
