import { existsSync, statSync } from 'node:fs'
import { resolve } from 'node:path'
import ts from 'typescript'
import type { ArchitecturePolicy, SourceInventory } from './architecture-policy.mts'
import {
  createModuleResolution,
  DECLARATION_EXTENSION,
  MODULE_EXTENSION,
  moduleReferences,
  RESOLUTION_CONFIGS,
  type ModuleReference,
} from './architecture-module-resolution.mts'

export interface ModuleEdge extends ModuleReference {
  from: string
  to: string
  kind: 'runtime' | 'type-only'
}
export interface LoadingDisposition extends ModuleReference {
  from: string
  target?: string
  disposition:
    | 'external'
    | 'asset'
    | 'native-build-output'
    | 'process-entry'
    | 'nonliteral'
    | 'discovery'
}
export interface GraphViolation {
  rule: string
  from?: string
  to?: string
  line?: number
  detail: string
}
export interface ModuleGraph {
  scope: { roots: string[]; configs: string[]; exclusions: string[] }
  modules: string[]
  edges: ModuleEdge[]
  loading: LoadingDisposition[]
  staticComponents: string[][]
  runtimeComponents: string[][]
  violations: GraphViolation[]
}

/** Tarjan over deterministic paths; same policy includes singleton runtime self-loops. */
export function cyclicComponents(modules: string[], edges: ModuleEdge[]): string[][] {
  const adjacency = new Map(modules.map((path) => [path, [] as string[]]))
  for (const edge of edges) adjacency.get(edge.from)!.push(edge.to)
  const ids = new Map<string, number>(),
    low = new Map<string, number>()
  const stack: string[] = [],
    active = new Set<string>(),
    components: string[][] = []
  let serial = 0
  function visit(path: string): void {
    ids.set(path, serial)
    low.set(path, serial++)
    stack.push(path)
    active.add(path)
    for (const target of adjacency.get(path)!) {
      if (!ids.has(target)) {
        visit(target)
        low.set(path, Math.min(low.get(path)!, low.get(target)!))
      } else if (active.has(target))
        low.set(path, Math.min(low.get(path)!, ids.get(target)!))
    }
    if (low.get(path) !== ids.get(path)) return
    const component: string[] = []
    let current: string
    do {
      current = stack.pop()!
      active.delete(current)
      component.push(current)
    } while (current !== path)
    if (component.length > 1 || adjacency.get(path)!.includes(path))
      components.push(component.sort())
  }
  for (const path of modules) if (!ids.has(path)) visit(path)
  return components.sort((a, b) => a.join('\0').localeCompare(b.join('\0'), 'en'))
}

export function collectModuleGraph(
  root: string,
  inventory: SourceInventory,
  policy: ArchitecturePolicy,
): ModuleGraph {
  const resolver = createModuleResolution(root)
  const modules = [...inventory.keys()]
    .filter((path) => MODULE_EXTENSION.test(path))
    .sort()
  const included = new Set(modules)
  const edges: ModuleEdge[] = [],
    loading: LoadingDisposition[] = [],
    violations: GraphViolation[] = []
  for (const from of modules) {
    const text = inventory.get(from)!.toString()
    const source = ts.createSourceFile(from, text, ts.ScriptTarget.Latest, true)
    const declaration = DECLARATION_EXTENSION.test(from)
    const emission = ts.transpileModule(text, {
      fileName: from.replace(/\.d(?=\.[cm]?ts$)/, ''),
      reportDiagnostics: true,
      compilerOptions: {
        ...resolver.options(from),
        noEmit: false,
        declaration: false,
        sourceMap: false,
        inlineSourceMap: false,
      },
    })
    const errors =
      emission.diagnostics?.filter((d) => d.category === ts.DiagnosticCategory.Error) ??
      []
    if (errors.length)
      throw new Error(
        `Malformed module input: ${from}: ${errors.map((d) => ts.flattenDiagnosticMessageText(d.messageText, ' ')).join('; ')}`,
      )
    const emitted = declaration ? '' : emission.outputText
    const runtime = new Set(
      moduleReferences(
        ts.createSourceFile(`${from}.js`, emitted, ts.ScriptTarget.Latest, true),
      )
        .filter((ref) => !ref.erased)
        .map((ref) => ref.specifier),
    )
    for (const ref of moduleReferences(source, resolver.options(from))) {
      const kind =
        !declaration && !ref.erased && runtime.has(ref.specifier)
          ? 'runtime'
          : 'type-only'
      if (!ref.specifier || ref.form === 'discovery') {
        loading.push({
          ...ref,
          from,
          disposition: ref.form === 'discovery' ? 'discovery' : 'nonliteral',
        })
        continue
      }
      if (ref.form === 'module-runner') {
        const target = ref.specifier.startsWith('/')
          ? ref.specifier.slice(1)
          : resolver.asset(from, ref.specifier)
        if (!included.has(target))
          violations.push({
            rule: 'unresolved-module-runner',
            from,
            to: target,
            line: ref.line,
            detail: 'Module-runner entry must be maintained source',
          })
        loading.push({ ...ref, from, target, disposition: 'discovery' })
        continue
      }
      if (ref.form === 'utility-process') {
        loading.push({ ...ref, from, disposition: 'discovery' })
        continue
      }
      const resolved = resolver.resolveReference(from, ref.specifier)
      let target = resolved.target
      if (resolved.external || (!target && !resolved.local)) {
        loading.push({ ...ref, from, disposition: 'external' })
        continue
      }
      if (!target) {
        target = resolver.asset(from, ref.specifier)
        if (
          from === 'packages/rename-noreplace/index.js' &&
          target === 'packages/rename-noreplace/build/Release/rename_noreplace.node'
        ) {
          for (const input of [
            'packages/rename-noreplace/binding.gyp',
            'packages/rename-noreplace/rename_noreplace.c',
          ]) {
            if (!existsSync(resolve(root, input)))
              throw new Error(`Missing required native build input: ${input}`)
          }
          loading.push({ ...ref, from, target, disposition: 'native-build-output' })
          continue
        }
        if (
          /\.(css|json|svg|png|jpe?g|gif|webp|avif|ico|wasm|txt|html|woff2?|ttf|otf)$/.test(
            target,
          ) &&
          !target.startsWith('../') &&
          existsSync(resolve(root, target)) &&
          statSync(resolve(root, target)).isFile()
        ) {
          loading.push({ ...ref, from, target, disposition: 'asset' })
          continue
        }
        violations.push({
          rule: 'unresolved-internal',
          from,
          to: target,
          line: ref.line,
          detail: `Unresolved internal ${ref.form}: ${ref.specifier}`,
        })
        continue
      }
      if (kind === 'runtime' && DECLARATION_EXTENSION.test(target)) {
        if (!included.has(target)) {
          violations.push({
            rule: 'unclassified-internal',
            from,
            to: target,
            line: ref.line,
            detail: 'Resolved declaration is absent from maintained inventory',
          })
          continue
        }
        edges.push({ ...ref, from, to: target, kind: 'type-only' })
        target = resolver.runtimeCompanion(from, ref.specifier, target)
        if (!target) {
          violations.push({
            rule: 'missing-runtime-implementation',
            from,
            line: ref.line,
            detail: `Emitted ${ref.form} has only a declaration: ${ref.specifier}`,
          })
          continue
        }
      }
      if (ref.form === 'worker') {
        if (!included.has(target))
          violations.push({
            rule: 'unclassified-process-entry',
            from,
            to: target,
            line: ref.line,
            detail: 'Worker entry must be maintained source',
          })
        loading.push({ ...ref, from, target, disposition: 'process-entry' })
      } else if (target.endsWith('.json')) {
        loading.push({ ...ref, from, target, disposition: 'asset' })
      } else if (!included.has(target)) {
        violations.push({
          rule: 'unclassified-internal',
          from,
          to: target,
          line: ref.line,
          detail: 'Resolved internal module is absent from maintained inventory',
        })
      } else edges.push({ ...ref, from, to: target, kind })
    }
  }
  const runtimeComponents = cyclicComponents(
    modules,
    edges.filter((edge) => edge.kind === 'runtime'),
  )
  for (const members of runtimeComponents)
    violations.push({ rule: 'runtime-cycle', detail: members.join(' -> ') })
  return {
    scope: {
      roots: [...policy.roots, '(repository root files)'],
      configs: RESOLUTION_CONFIGS,
      exclusions: [
        'Installed dependencies and builtins are external module leaves.',
        'Git internals and disposable output retain the maintained inventory exclusions.',
        'Non-code assets and exact native build output are explicit loading rows.',
        'Worker process entries and nonliteral discovery are outside same-module cycle proof.',
      ],
    },
    modules,
    edges,
    loading,
    staticComponents: cyclicComponents(modules, edges),
    runtimeComponents,
    violations,
  }
}
